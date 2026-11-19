import { isRecord } from "../dispatch/jsonl";
import type { RepoClient } from "./api";

export interface PullRequest {
  number: number;
  htmlUrl: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
  draft: boolean;
}

function toPull(raw: unknown): PullRequest {
  if (!isRecord(raw) || typeof raw.number !== "number" || typeof raw.html_url !== "string" || !isRecord(raw.head) || typeof raw.head.sha !== "string" || !isRecord(raw.base) || typeof raw.base.sha !== "string" || typeof raw.base.ref !== "string") {
    throw new Error("GitHub returned an unexpected pull request shape");
  }
  return { number: raw.number, htmlUrl: raw.html_url, headSha: raw.head.sha, baseSha: raw.base.sha, baseRef: raw.base.ref, draft: raw.draft === true };
}

/** The open pull request from `head` (a branch of this repo) into `base`, or a new draft one; never a second. */
export async function ensureDraftPullRequest(client: RepoClient, req: { head: string; base: string; title: string; body: string }): Promise<{ pull: PullRequest; created: boolean }> {
  const q = new URLSearchParams({ head: `${client.owner}:${req.head}`, base: req.base, state: "open" });
  const open = await client.request<unknown[]>("GET", `${client.base}/pulls?${q}`);
  if (Array.isArray(open) && open.length > 0) return { pull: toPull(open[0]), created: false };
  const created = await client.request("POST", `${client.base}/pulls`, { head: req.head, base: req.base, title: req.title, body: req.body, draft: true });
  return { pull: toPull(created), created: true };
}

export async function getPullRequest(client: RepoClient, number: number): Promise<PullRequest> {
  return toPull(await client.request("GET", `${client.base}/pulls/${number}`));
}

export interface IssueComment {
  id: number;
  htmlUrl: string;
  body: string;
  /** The author's login, such as `software-factory-9f09[bot]`. */
  author: string;
}

function toComment(raw: unknown): IssueComment {
  if (!isRecord(raw) || typeof raw.id !== "number" || typeof raw.html_url !== "string") throw new Error("GitHub returned an unexpected comment shape");
  return { id: raw.id, htmlUrl: raw.html_url, body: typeof raw.body === "string" ? raw.body : "", author: isRecord(raw.user) && typeof raw.user.login === "string" ? raw.user.login : "" };
}

const MAX_COMMENT_CHARS = 65_000;
/** Pages of 100 comments read when looking for the factory's own; a PR with more is refused rather than half-read. */
const MAX_COMMENT_PAGES = 20;

/** Posts an issue comment on the pull request and returns it. */
export async function postComment(client: RepoClient, number: number, body: string): Promise<IssueComment> {
  if (body.length > MAX_COMMENT_CHARS) throw new Error(`comment is ${body.length} characters; GitHub allows 65536`);
  return toComment(await client.request("POST", `${client.base}/issues/${number}/comments`, { body }));
}

export async function updateComment(client: RepoClient, id: number, body: string): Promise<IssueComment> {
  if (body.length > MAX_COMMENT_CHARS) throw new Error(`comment is ${body.length} characters; GitHub allows 65536`);
  return toComment(await client.request("PATCH", `${client.base}/issues/comments/${id}`, { body }));
}

/** Every comment on the pull request, oldest first. */
export async function listComments(client: RepoClient, number: number): Promise<IssueComment[]> {
  const out: IssueComment[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const raw = await client.request<unknown[]>("GET", `${client.base}/issues/${number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(raw)) throw new Error("GitHub returned an unexpected comment list");
    out.push(...raw.map(toComment));
    if (raw.length < 100) return out;
  }
  throw new Error(`PR #${number} has more than ${MAX_COMMENT_PAGES * 100} comments; refusing to guess which is the factory's`);
}
