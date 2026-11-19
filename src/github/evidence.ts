/**
 * Evidence upload: GitHub has no API for comment attachments, so screenshots are committed to a dedicated orphan
 * branch through the Git Data API and the PR comment links them at the evidence commit. In a private repository
 * GitHub serves `/<owner>/<repo>/blob/<sha>/<path>?raw=true` to any signed-in viewer with read access, so the images
 * render inline for the owner and for nobody without access (spike 02).
 *
 * Every page-derived string (console text, URLs, page text) is untrusted: it only ever appears inside a fenced code
 * block, where GitHub renders no mentions, links, images, or HTML, and the body always starts with the factory marker.
 */
import { readFileSync } from "node:fs";
import type { EvidenceRecord } from "../verify/evidence";
import type { RepoClient } from "./api";
import { assertRepoPath, commitFiles } from "./commit";
import { postComment } from "./pulls";

export const EVIDENCE_BRANCH = "factory-evidence";
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BLOCK_LIMIT = 2_000;

export interface EvidenceSet {
  pr: number;
  /** The PR head the evidence was captured for. */
  headSha: string;
  /** Attempt id of the verification. */
  attemptId: string;
  /** Short trusted heading, such as `Before (base)`; one section per group. */
  groups: readonly { title: string; records: readonly EvidenceRecord[] }[];
}

export function evidencePath(set: EvidenceSet, record: EvidenceRecord): string {
  const path = `pr-${set.pr}/${set.attemptId}/${record.name}.png`;
  assertRepoPath(path);
  return path;
}

/** The URL GitHub renders inline for signed-in viewers with read access to the private repo. */
export function evidenceImageUrl(client: Pick<RepoClient, "owner" | "repo">, commitSha: string, path: string): string {
  if (!SHA.test(commitSha)) throw new Error(`not a commit id: ${commitSha}`);
  assertRepoPath(path);
  return `https://github.com/${client.owner}/${client.repo}/blob/${commitSha}/${path}?raw=true`;
}

/** A fenced block that no content can close early: the fence is longer than any backtick run inside. */
export function fenced(text: string, limit = BLOCK_LIMIT): string {
  const body = text.length > limit ? `${text.slice(0, limit)}\n[... ${text.length - limit} more characters]` : text;
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${body}\n${fence}`;
}

function assertSet(set: EvidenceSet): void {
  if (!Number.isSafeInteger(set.pr) || set.pr <= 0) throw new Error(`not a PR number: ${set.pr}`);
  if (!SHA.test(set.headSha)) throw new Error(`head must be a full commit id: ${set.headSha}`);
  if (!UUID.test(set.attemptId)) throw new Error(`attempt id must be a lowercase UUID: ${set.attemptId}`);
  const names = new Set<string>();
  for (const g of set.groups) {
    if (!/^[A-Za-z0-9 ()._:-]{1,80}$/.test(g.title)) throw new Error(`group title must be plain words: ${JSON.stringify(g.title)}`);
    for (const r of g.records) {
      if (names.has(r.name)) throw new Error(`duplicate evidence name ${r.name}`);
      names.add(r.name);
      if (!SHA.test(r.commitSha)) throw new Error(`record ${r.name} has no full commit id`);
    }
  }
  if (names.size === 0) throw new Error("no evidence records");
}

/** The comment body for an evidence set whose screenshots are committed at `evidenceCommit`. */
export function evidenceComment(client: Pick<RepoClient, "owner" | "repo">, set: EvidenceSet, evidenceCommit: string): string {
  assertSet(set);
  const out = [
    `<!-- factory:evidence pr=${set.pr} head=${set.headSha} attempt=${set.attemptId} evidence=${evidenceCommit} -->`,
    `### Verification evidence`,
    "",
    `PR head \`${set.headSha.slice(0, 12)}\`, attempt \`${set.attemptId}\`, files on [\`${EVIDENCE_BRANCH}\`](https://github.com/${client.owner}/${client.repo}/tree/${evidenceCommit}/pr-${set.pr}/${set.attemptId}).`,
  ];
  for (const g of set.groups) {
    out.push("", `#### ${g.title}`);
    for (const r of g.records) {
      const v = r.viewport;
      out.push(
        "",
        `**${r.acId ?? "AC pending"} - ${v.name} ${v.width}x${v.height}** at \`${r.commitSha.slice(0, 12)}\`, ${r.consoleErrors.length} console errors, ${r.networkFailures.length} failed requests`,
        "",
        `<img src="${evidenceImageUrl(client, evidenceCommit, evidencePath(set, r))}" alt="${r.name}" width="${v.name === "mobile" ? 240 : 560}">`,
      );
      const details = [
        `URL: ${r.url}`,
        `Console errors:${r.consoleErrors.length ? "" : " none"}`,
        ...r.consoleErrors.map((e) => `  ${e}`),
        `Failed requests:${r.networkFailures.length ? "" : " none"}`,
        ...r.networkFailures.map((f) => `  ${f.method} ${f.url} -> ${f.status ?? "no response"}`),
        `Page text:`,
        r.pageText,
      ].join("\n");
      out.push("", "<details><summary>Console, network, and page text</summary>", "", fenced(details), "", "</details>");
    }
  }
  return out.join("\n");
}

export interface PublishedEvidence {
  evidenceCommit: string;
  commentId: number;
  commentUrl: string;
  imageUrls: string[];
}

/**
 * Commits the screenshots and the records to the evidence branch (created as an orphan, then only fast-forwarded),
 * then comments on the PR with the images linked at that commit, so later evidence never changes what a comment shows.
 */
export async function publishEvidence(client: RepoClient, set: EvidenceSet): Promise<PublishedEvidence> {
  assertSet(set);
  const records = set.groups.flatMap((g) => g.records);
  const files = records.map((r) => ({ path: evidencePath(set, r), content: readFileSync(r.screenshotPath) }));
  const manifest = set.groups.map((g) => ({ title: g.title, records: g.records.map((r) => ({ ...r, screenshotPath: evidencePath(set, r) })) }));
  files.push({ path: `pr-${set.pr}/${set.attemptId}/evidence.json`, content: Buffer.from(`${JSON.stringify({ pr: set.pr, headSha: set.headSha, attemptId: set.attemptId, groups: manifest }, null, 2)}\n`) });
  const { commitSha } = await commitFiles(client, {
    branch: EVIDENCE_BRANCH,
    startFrom: null,
    message: `chore(evidence): PR #${set.pr} at ${set.headSha.slice(0, 12)}\n\nFactory-Attempt: ${set.attemptId}`,
    files,
  });
  const comment = await postComment(client, set.pr, evidenceComment(client, set, commitSha));
  return { evidenceCommit: commitSha, commentId: comment.id, commentUrl: comment.htmlUrl, imageUrls: records.map((r) => evidenceImageUrl(client, commitSha, evidencePath(set, r))) };
}
