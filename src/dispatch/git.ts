import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

const GIT_TIMEOUT_MS = 10_000;

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

/**
 * git from the trusted path, with no system or global config, replace refs, or prompts, so only the repo itself
 * decides what is read.
 */
export function runGit(gitPath: string, repo: string, args: string[]): Buffer {
  const r = Bun.spawnSync([gitPath, "--no-replace-objects", "-C", repo, ...args], {
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
    stdin: "ignore",
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (r.exitedDueToTimeout) throw new GitError(`git ${args[0]} gave no answer within ${GIT_TIMEOUT_MS}ms`, "");
  const stderr = r.stderr.toString("utf8").trim();
  if (r.exitCode !== 0) throw new GitError(`git ${args[0]} failed in ${repo}: ${stderr.slice(0, 300) || `exit ${r.exitCode}`}`, stderr);
  return r.stdout;
}

/**
 * The git paths a run must not write, canonical: the common git dir (objects, refs, hooks, config, shared by every
 * worktree of the repo), the worktree's own admin dir under it, and the worktree's `.git` link file, which would
 * otherwise let an agent point a later run's lookup somewhere else. Agents never commit, so none of it needs writing.
 * Empty when the worktree has no `.git` entry and is not in a git repository; any other git failure throws.
 */
export function gitWriteProtectedPaths(gitPath: string, worktree: string): string[] {
  const link = join(worktree, ".git");
  let hasGitEntry = false;
  try {
    lstatSync(link);
    hasGitEntry = true;
  } catch {
    // no .git entry
  }
  let out: string;
  try {
    out = runGit(gitPath, worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"]).toString("utf8");
  } catch (err) {
    // A broken or redirected .git link is refused rather than leaving the git dirs unprotected.
    if (!hasGitEntry && err instanceof GitError && /not a git repository/.test(err.stderr)) return [];
    throw err;
  }
  const [common, admin] = out.split("\n").filter(Boolean);
  if (!common || !admin) throw new Error(`git rev-parse gave no git dirs for ${worktree}`);
  const paths = [realpathSync(common), realpathSync(admin)];
  if (hasGitEntry && lstatSync(link).isFile()) paths.push(link);
  return [...new Set(paths)];
}
