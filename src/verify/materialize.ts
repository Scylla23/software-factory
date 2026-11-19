import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isUnder } from "../dispatch/config";
import { runGit } from "../dispatch/git";

const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CHECKOUT_TIMEOUT_MS = 120_000;

export interface MaterializeInput {
  /** The factory-controlled checkout that holds the commit; refused when an agent could write to it. */
  repo: string;
  /** Full lowercase commit id. */
  sha: string;
  /** Existing directory the detached worktree is created in, as `<root>/<name>`. */
  root: string;
  name: string;
  /** Roots agents can write (worktrees, temp dirs): the repo must be outside all of them. */
  untrustedRoots: readonly string[];
}

export interface Materialized {
  repo: string;
  sha: string;
  /** Canonical path of the detached worktree. */
  path: string;
}

/**
 * Checks out exactly `sha` as a detached worktree with the trusted git runner.
 * Hooks never run (`core.hooksPath=/dev/null`; checkout would otherwise run `post-checkout` in the factory process),
 * and HEAD is verified to be the requested commit afterwards.
 */
export function materializeCommit(gitPath: string, input: MaterializeInput): Materialized {
  if (!SHA.test(input.sha)) throw new Error(`sha must be a full lowercase commit id: ${input.sha}`);
  if (!NAME.test(input.name)) throw new Error(`worktree name must match ${NAME}: ${input.name}`);
  const repo = realpathSync(input.repo);
  for (const r of input.untrustedRoots) if (isUnder(repo, r)) throw new Error(`repo ${repo} is under agent-writable ${r}`);
  const root = realpathSync(input.root);
  if (isUnder(root, repo)) throw new Error(`preview root ${root} is inside the repo ${repo}`);
  const path = join(root, input.name);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  const resolved = runGit(gitPath, repo, ["rev-parse", "--verify", "--end-of-options", `${input.sha}^{commit}`]).toString().trim();
  if (resolved !== input.sha) throw new Error(`${input.sha} resolves to ${resolved} in ${repo}`);
  runGit(gitPath, repo, ["-c", "core.hooksPath=/dev/null", "-c", "advice.detachedHead=false", "worktree", "add", "--detach", "--", path, input.sha], CHECKOUT_TIMEOUT_MS);
  const real = realpathSync(path);
  const head = runGit(gitPath, real, ["rev-parse", "HEAD"]).toString().trim();
  if (head !== input.sha) {
    removeMaterialized(gitPath, { repo, sha: input.sha, path: real });
    throw new Error(`worktree HEAD is ${head}, expected ${input.sha}`);
  }
  return { repo, sha: input.sha, path: real };
}

/** Removes the worktree (with whatever the preview wrote in it) and its git admin entry. */
export function removeMaterialized(gitPath: string, m: Materialized): void {
  let present = true;
  try {
    lstatSync(m.path);
  } catch {
    present = false;
  }
  if (present) runGit(gitPath, m.repo, ["-c", "core.hooksPath=/dev/null", "worktree", "remove", "--force", "--force", "--", m.path], CHECKOUT_TIMEOUT_MS);
  runGit(gitPath, m.repo, ["worktree", "prune"]);
}
