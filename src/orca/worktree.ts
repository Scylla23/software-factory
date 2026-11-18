import { isRecord, str } from "../dispatch/json";

export interface OrcaWorktree {
  /** Orca's two-part id, `<repoId>::<path>`. */
  id: string;
  path: string;
  branch: string;
}

function orcaJson(args: string[], cwd?: string): Record<string, unknown> {
  const proc = Bun.spawnSync(["orca", ...args, "--json"], { cwd, stdout: "pipe", stderr: "pipe" });
  let out: unknown;
  try {
    out = JSON.parse(proc.stdout.toString());
  } catch {
    throw new Error(`orca ${args[0]} ${args[1]}: exit ${proc.exitCode}, unparseable output: ${proc.stderr.toString().slice(0, 500)}`);
  }
  if (!isRecord(out) || out.ok !== true || !isRecord(out.result)) {
    throw new Error(`orca ${args[0]} ${args[1]} failed: ${JSON.stringify(isRecord(out) ? out.error : out).slice(0, 500)}`);
  }
  return out.result;
}

/** Creates an independent worktree in the project that contains `repoCwd`, without setup hooks or an agent. */
export function createWorktree(name: string, repoCwd: string): OrcaWorktree {
  const result = orcaJson(["worktree", "create", "--name", name, "--no-parent", "--setup", "skip"], repoCwd);
  const wt = isRecord(result.worktree) ? result.worktree : {};
  const id = str(wt.id);
  const path = str(wt.path);
  const branch = str(wt.branch);
  if (!id || !path || !branch) throw new Error(`orca worktree create returned no id/path/branch: ${JSON.stringify(result).slice(0, 500)}`);
  return { id, path, branch };
}

/** Removes the worktree and deletes its branch if Orca can prove it is merged. */
export function removeWorktree(id: string): void {
  orcaJson(["worktree", "rm", "--worktree", `id:${id}`, "--force", "--delete-branch"]);
}
