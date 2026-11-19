import { realpathSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_READ } from "../verify/sandbox";
import type { AttemptDirectories, SkillRole } from "./attempt";
import { gitWriteProtectedPaths } from "./git";
import { overlaps, type SandboxPolicy } from "./policy";

export function skillPolicy(
  role: SkillRole, dirs: AttemptDirectories, denyRead: readonly string[],
  tools: readonly string[], binaryRoots: readonly string[], git: string,
): SandboxPolicy {
  const builder = role === "builder";
  const gitDirs = [dirs.worktree, ...(dirs.scratchRepo ? [dirs.scratchRepo] : [])]
    .flatMap(tree => gitWriteProtectedPaths(git, tree));
  const readable = [...new Set([dirs.worktree, dirs.skillsDir, dirs.taskDir, ...gitDirs,
    ...tools.map(p => realpathSync(p)), ...SYSTEM_READ.map(p => realpathSync(p)), ...binaryRoots])];
  const writable = [dirs.outDir, dirs.scratchDir, ...(builder ? [dirs.worktree] : [])];
  const deny = [...new Set([...denyRead, join(dirs.root, "agents")])];
  for (const path of writable) {
    if (deny.some(p => overlaps(p, path))) throw new Error(`skill write root overlaps a mandatory denial: ${path}`);
  }
  for (const path of readable) {
    if (!binaryRoots.includes(path) && deny.some(d => path === d || path.startsWith(d + "/")))
      throw new Error(`skill read root inside a mandatory denial: ${path}`);
  }
  const denyWrite = [...new Set([...gitDirs, dirs.skillsDir, dirs.taskDir, ...(builder ? [] : [dirs.worktree])])];
  return { readable, writable, denyRead: deny, denyWrite };
}
