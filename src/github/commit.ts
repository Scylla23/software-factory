import { isRecord } from "../dispatch/jsonl";
import type { RepoClient } from "./api";
import { GitHubError } from "./app";

export interface FileToCommit {
  /** Repo-relative path with plain segments. */
  path: string;
  content: Uint8Array;
}

export interface CommitRequest {
  branch: string;
  message: string;
  files: readonly FileToCommit[];
  /**
   * The commit a missing branch starts from; null starts it as an orphan (a root commit with only these files).
   * An existing branch always gets the new commit on top of its head, never a force update.
   */
  startFrom: string | null;
  /** When supplied, publish only on this exact parent, or only to a missing branch for null. */
  expectedHead?: string | null;
}

export interface CommitResult {
  commitSha: string;
  /** The branch head the commit was made on, or null when it created the branch. */
  parentSha: string | null;
}

const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._\/-]{1,200}$/;

export function assertRepoPath(path: string): void {
  const segments = path.split("/");
  if (path.length > 400 || segments.some((s) => s === "" || s === "." || s === ".." || !/^[A-Za-z0-9._-]+$/.test(s))) {
    throw new Error(`not a plain repo path: ${JSON.stringify(path)}`);
  }
}

/**
 * Commits files to a branch through the Git Data API, so no git credentials ever touch disk.
 * The ref moves only by fast-forward; if another writer moved it first, the commit is rebuilt once on the new head.
 */
export async function commitFiles(client: RepoClient, req: CommitRequest): Promise<CommitResult> {
  if (!BRANCH.test(req.branch)) throw new Error(`not a safe branch name: ${JSON.stringify(req.branch)}`);
  if (req.startFrom !== null && !SHA.test(req.startFrom)) throw new Error(`startFrom must be a full commit id: ${req.startFrom}`);
  if (req.files.length === 0) throw new Error("nothing to commit");
  const seen = new Set<string>();
  for (const f of req.files) {
    assertRepoPath(f.path);
    if (seen.has(f.path)) throw new Error(`duplicate path ${f.path}`);
    seen.add(f.path);
  }

  const blobs: { path: string; sha: string }[] = [];
  for (const f of req.files) {
    const blob = await client.request<{ sha: string }>("POST", `${client.base}/git/blobs`, { content: Buffer.from(f.content).toString("base64"), encoding: "base64" });
    blobs.push({ path: f.path, sha: shaOf(blob, "blob") });
  }

  for (let attempt = 0; ; attempt++) {
    const head = await client.request<{ object: { sha: string } }>("GET", `${client.base}/git/ref/heads/${req.branch}`, undefined, { allow404: true });
    const parentSha = head ? shaOf(isRecord(head) ? head.object : null, "ref") : null;
    if (req.expectedHead !== undefined && parentSha !== req.expectedHead) throw new Error("branch moved before publication");
    const parent = parentSha ?? req.startFrom;
    let baseTree: string | null = null;
    if (parent) {
      const commit = await client.request<{ tree: { sha: string } }>("GET", `${client.base}/git/commits/${parent}`);
      baseTree = shaOf(isRecord(commit) ? commit.tree : null, "tree");
    }
    const tree = await client.request<{ sha: string }>("POST", `${client.base}/git/trees`, {
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: blobs.map((b) => ({ path: b.path, mode: "100644", type: "blob", sha: b.sha })),
    });
    const commit = await client.request<{ sha: string }>("POST", `${client.base}/git/commits`, {
      message: req.message,
      tree: shaOf(tree, "tree"),
      parents: parent ? [parent] : [],
    });
    const commitSha = shaOf(commit, "commit");
    try {
      if (parentSha) await client.request("PATCH", `${client.base}/git/refs/heads/${req.branch}`, { sha: commitSha, force: false });
      else await client.request("POST", `${client.base}/git/refs`, { ref: `refs/heads/${req.branch}`, sha: commitSha });
      return { commitSha, parentSha };
    } catch (err) {
      // 422: the branch moved (not a fast-forward) or appeared since it was read; rebuild once on its new head.
      if (req.expectedHead === undefined && attempt === 0 && err instanceof GitHubError && err.status === 422) continue;
      throw err;
    }
  }
}

function shaOf(value: unknown, what: string): string {
  if (isRecord(value) && typeof value.sha === "string" && SHA.test(value.sha)) return value.sha;
  throw new Error(`GitHub returned no ${what} sha`);
}
