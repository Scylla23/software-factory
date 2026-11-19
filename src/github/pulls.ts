import { isRecord } from "../dispatch/jsonl";
import type { RepoClient } from "./api";

export interface PullRequest {
  number: number;
  htmlUrl: string;
  headSha: string;
  draft: boolean;
}

function toPull(raw: unknown): PullRequest {
  if (!isRecord(raw) || typeof raw.number !== "number" || typeof raw.html_url !== "string" || !isRecord(raw.head) || typeof raw.head.sha !== "string") {
    throw new Error("GitHub returned an unexpected pull request shape");
  }
  return { number: raw.number, htmlUrl: raw.html_url, headSha: raw.head.sha, draft: raw.draft === true };
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

/** Posts an issue comment on the pull request and returns its id and URL. */
export async function postComment(client: RepoClient, number: number, body: string): Promise<{ id: number; htmlUrl: string }> {
  if (body.length > 65_000) throw new Error(`comment is ${body.length} characters; GitHub allows 65536`);
  const raw = await client.request("POST", `${client.base}/issues/${number}/comments`, { body });
  if (!isRecord(raw) || typeof raw.id !== "number" || typeof raw.html_url !== "string") throw new Error("GitHub returned an unexpected comment shape");
  return { id: raw.id, htmlUrl: raw.html_url };
}
