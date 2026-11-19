/**
 * The PR's view of a verification: one text-only comment from the App, built from allowlisted fields. Screenshots,
 * logs, and full records stay in the local evidence store (src/verify/store.ts); the comment names where.
 *
 * Every page-derived or command-derived string is redacted (query strings, token-like values, emails, the account's
 * home path), capped, and shown only inside a fenced block it cannot close, where GitHub renders no mentions, links,
 * images, or HTML. The body starts with a marker naming the PR, the attempt, and the revisions it was captured at, so a
 * retry of the same attempt updates the App's own comment instead of adding another.
 */
import { homedir } from "node:os";
import type { EvidenceRecord } from "../verify/evidence";
import { type Check, verdict } from "../verify/verdict";
import type { RepoClient } from "./api";
import { getPullRequest, listComments, postComment, updateComment } from "./pulls";

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Per diagnostic excerpt, and for the whole diagnostics block. */
const EXCERPT_CHARS = 300;
const DIAGNOSTICS_CHARS = 12_000;
const CONSOLE_LINES = 3;

export interface EvidenceSummary {
  pr: number;
  attemptId: string;
  /** The PR's base and head as recorded before capture. Every capture is of one of these two commits. */
  base: string;
  head: string;
  checks: readonly Check[];
  captures: readonly EvidenceRecord[];
  /** The attempt's local evidence directory. */
  evidenceDir: string;
}

/** Refused before any GitHub call: the attempt did not pass, so there is nothing to publish. */
export class EvidenceGateError extends Error {}

/** Refused before posting: the PR moved since capture, so the evidence is for revisions it no longer has. */
export class StaleEvidenceError extends Error {}

const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Long unbroken runs of key-like characters: hashes, API keys, session ids.
  /\b[A-Za-z0-9+/_=-]{32,}\b/g,
];

/**
 * Untrusted text made fit for the PR: URLs lose their query and fragment, token-like values and emails are replaced,
 * the account's home becomes `~`, control characters go, and the result is capped.
 */
export function redact(text: string, cap = EXCERPT_CHARS): string {
  let t = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
  t = t.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi, (u) => {
    try {
      const url = new URL(u);
      return `${url.protocol}//${url.host}${url.pathname}${url.search || url.hash ? "?[redacted]" : ""}`;
    } catch {
      return "[url]";
    }
  });
  for (const p of SECRET_PATTERNS) t = t.replace(p, "[redacted]");
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  const home = homedir();
  if (home.length > 1) t = t.split(home).join("~");
  return t.length > cap ? `${t.slice(0, cap)} [... ${t.length - cap} more characters]` : t;
}

/** A fenced block that no content can close early: the fence is longer than any backtick run inside. */
export function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

export function summaryMarker(s: Pick<EvidenceSummary, "pr" | "attemptId" | "base" | "head">): string {
  return `<!-- factory:evidence pr=${s.pr} attempt=${s.attemptId} base=${s.base} head=${s.head} capture=${s.head} -->`;
}

/** The marker's stable part: one comment per PR and attempt, whatever revisions a retry records. */
const markerKey = (pr: number, attemptId: string) => `<!-- factory:evidence pr=${pr} attempt=${attemptId} `;

function assertSummary(s: EvidenceSummary): void {
  if (!Number.isSafeInteger(s.pr) || s.pr <= 0) throw new Error(`not a PR number: ${s.pr}`);
  if (!UUID.test(s.attemptId)) throw new Error(`attempt id must be a lowercase UUID: ${s.attemptId}`);
  if (!SHA.test(s.base) || !SHA.test(s.head)) throw new Error("base and head must be full commit ids");
  if (s.captures.length === 0) throw new Error("no captures");
  const names = new Set<string>();
  for (const r of s.captures) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(r.name)) throw new Error(`capture name must match [a-z0-9-]: ${JSON.stringify(r.name)}`);
    if (names.has(r.name)) throw new Error(`duplicate capture ${r.name}`);
    names.add(r.name);
    if (r.commitSha !== s.base && r.commitSha !== s.head) throw new Error(`capture ${r.name} is of ${r.commitSha}, which is neither the recorded base nor head`);
    if (!/^[0-9a-f]{64}$/.test(r.screenshotSha256)) throw new Error(`capture ${r.name} has no screenshot hash`);
  }
  if (!s.captures.some((r) => r.commitSha === s.head)) throw new Error("no capture is of the PR head");
}

const short = (sha: string) => `\`${sha.slice(0, 12)}\``;

/** The comment body: allowlisted fields in the open, redacted diagnostics fenced. */
export function summaryComment(s: EvidenceSummary): string {
  assertSummary(s);
  const v = verdict(s.checks);
  const home = homedir();
  const where = home.length > 1 && s.evidenceDir.startsWith(`${home}/`) ? `~${s.evidenceDir.slice(home.length)}` : s.evidenceDir;
  if (!/^[A-Za-z0-9~/._-]{1,300}$/.test(where)) throw new Error(`evidence dir is not a plain path: ${JSON.stringify(where)}`);
  const out = [
    summaryMarker(s),
    `### Verification: ${v.pass ? "passed" : "FAILED"}`,
    "",
    `PR #${s.pr}: base ${short(s.base)}, head ${short(s.head)}, attempt \`${s.attemptId}\`.`,
    `Screenshots, logs, and full records are on the factory host only, in \`${where}\`; nothing else was uploaded.`,
    "Browser egress during capture was unrestricted: Orca cannot limit a page to the preview origin.",
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...s.checks.map((c) => `| ${c.name} | ${c.pass ? "pass" : "**fail**"} |`),
    "",
    "| Capture | Commit | Viewport | Console errors | Failed requests | Other origins | Screenshot sha256 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...s.captures.map((r) => {
      const vp = r.viewport;
      return `| ${r.name} | ${short(r.commitSha)}${r.commitSha === s.head ? " head" : " base"} | ${vp.name} ${vp.width}x${vp.height}@${vp.scale} | ${r.consoleErrors.length} | ${r.networkFailures.length} | ${r.externalOrigins.length} | \`${r.screenshotSha256}\` |`;
    }),
  ];
  const diag: string[] = [];
  for (const c of s.checks) if (c.detail) diag.push(`[check] ${c.name}: ${redact(c.detail)}`);
  for (const r of s.captures) {
    diag.push(`[${r.name}] page ${redact(r.url)}`);
    for (const e of r.consoleErrors.slice(0, CONSOLE_LINES)) diag.push(`[${r.name}] console: ${redact(e)}`);
    if (r.consoleErrors.length > CONSOLE_LINES) diag.push(`[${r.name}] console: ${r.consoleErrors.length - CONSOLE_LINES} more`);
    for (const f of r.networkFailures.slice(0, CONSOLE_LINES)) diag.push(`[${r.name}] request: ${f.method} ${redact(f.url)} -> ${f.status ?? "no response"}`);
    if (r.externalOrigins.length > 0) diag.push(`[${r.name}] other origins: ${redact(r.externalOrigins.join(" "))}`);
    diag.push(`[${r.name}] page text: ${redact(r.pageText)}`);
  }
  let block = diag.join("\n");
  if (block.length > DIAGNOSTICS_CHARS) block = `${block.slice(0, DIAGNOSTICS_CHARS)}\n[... ${block.length - DIAGNOSTICS_CHARS} more characters]`;
  out.push("", "<details><summary>Redacted diagnostics</summary>", "", fenced(block), "", "</details>");
  return out.join("\n");
}

export interface PublishedSummary {
  id: number;
  htmlUrl: string;
  /** True when a retry found and updated this attempt's earlier comment. */
  updated: boolean;
}

/**
 * Publishes the summary of a passed attempt: refuses a failed verdict before any call, re-reads the PR and refuses if
 * its base or head moved since capture, then updates the App's own comment for this PR and attempt if one exists
 * (a retry after a lost response included), or posts one.
 */
export async function publishSummary(client: RepoClient, s: EvidenceSummary, opts: { botLogin: string }): Promise<PublishedSummary> {
  const v = verdict(s.checks);
  if (!v.pass) throw new EvidenceGateError(`refusing to publish attempt ${s.attemptId}: failed checks ${v.failed.join(", ")}`);
  const body = summaryComment(s);
  const pull = await getPullRequest(client, s.pr);
  if (pull.headSha !== s.head || pull.baseSha !== s.base) {
    throw new StaleEvidenceError(`PR #${s.pr} moved since capture: base ${s.base.slice(0, 12)} -> ${pull.baseSha.slice(0, 12)}, head ${s.head.slice(0, 12)} -> ${pull.headSha.slice(0, 12)}`);
  }
  const key = markerKey(s.pr, s.attemptId);
  const mine = (await listComments(client, s.pr)).filter((c) => c.author === opts.botLogin && c.body.startsWith(key));
  if (mine.length > 1) throw new Error(`PR #${s.pr} has ${mine.length} comments for attempt ${s.attemptId}; refusing to pick one`);
  if (mine.length === 1) {
    const c = await updateComment(client, mine[0]!.id, body);
    return { id: c.id, htmlUrl: c.htmlUrl, updated: true };
  }
  const c = await postComment(client, s.pr, body);
  return { id: c.id, htmlUrl: c.htmlUrl, updated: false };
}
