import { isRecord, str } from "../dispatch/jsonl";
import { orcaJson } from "./cli";

export interface OrcaWorktree {
  /** Orca's two-part id, `<repoId>::<path>`. */
  id: string;
  path: string;
  branch: string;
}

/**
 * Creates an independent worktree of the project whose main checkout is `repoPath`, without setup hooks or an agent.
 * Orca answers `repo_not_found` for a path that is only a worktree of the repo.
 * `orcaPath` is the trusted executable from DispatchConfig.
 */
export async function createWorktree(orcaPath: string, name: string, repoPath: string): Promise<OrcaWorktree> {
  const result = await orcaJson(orcaPath, ["worktree", "create", "--repo", `path:${repoPath}`, "--name", name, "--no-parent", "--setup", "skip"]);
  const wt = isRecord(result.worktree) ? result.worktree : {};
  const id = str(wt.id);
  const path = str(wt.path);
  const branch = str(wt.branch);
  if (!id || !path || !branch) throw new Error(`orca worktree create returned no id/path/branch: ${JSON.stringify(result).slice(0, 500)}`);
  return { id, path, branch };
}

/** Removes the worktree and deletes its branch if Orca can prove it is merged. */
export async function removeWorktree(orcaPath: string, id: string): Promise<void> {
  await orcaJson(orcaPath, ["worktree", "rm", "--worktree", `id:${id}`, "--force", "--delete-branch"]);
}
