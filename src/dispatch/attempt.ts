import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertPrivateDir, assertSafeDir, tempRoots } from "./config";
import { runGit } from "./git";
import { overlaps } from "./policy";

export type SkillRole = "spec-lead" | "triage" | "builder" | "spec-reviewer" | "code-reviewer" | "database-auditor" | "security-auditor" | "verifier";

export interface AttemptDirectories {
  role: SkillRole;
  stage: string;
  root: string;
  taskDir: string;
  skillsDir: string;
  outDir: string;
  scratchDir: string;
  worktree: string;
  scratchRepo?: string;
  agentsDir?: string;
  outputIdentity: { dev: bigint; ino: bigint };
}

/** Create the attempt once. A surviving directory is evidence of a prior launch. */
export function createAttempt(input: {
  runRoot: string; stateRoot: string; accountHome: string; project: string;
  attemptId: string; role: SkillRole; stage: string;
}): AttemptDirectories {
  const { runRoot, attemptId, role, stage } = input;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(attemptId)) throw new Error("invalid attempt id");
  const project = realpathSync(input.project);
  if (runRoot !== join(realpathSync(dirname(runRoot)), runRoot.split("/").at(-1)!)) throw new Error("run root must be canonical");
  for (const protectedPath of [realpathSync(input.stateRoot), project, ...tempRoots()]) {
    if (overlaps(runRoot, protectedPath)) throw new Error(`run root overlaps ${protectedPath}`);
  }
  assertSafeDir(dirname(runRoot), input.accountHome);
  if (!existsSync(runRoot)) {
    try { mkdirSync(runRoot, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  assertPrivateDir(runRoot, runRoot);
  assertSafeDir(runRoot, input.accountHome);
  const root = join(runRoot, attemptId);
  mkdirSync(root, { mode: 0o700 });
  try {
    const dir = (name: string) => {
      const path = join(root, name);
      mkdirSync(path, { mode: 0o700 });
      return path;
    };
    const taskDir = dir("task");
    const skillsDir = dir("skills");
    const outDir = dir("out");
    const scratchDir = dir("scratch");
    const needsCopy = role === "code-reviewer" || role === "database-auditor" || (role === "security-auditor" && stage === "code");
    const stat = lstatSync(outDir, { bigint: true });
    return {
      role, stage, root, taskDir, skillsDir, outDir, scratchDir, outputIdentity: { dev: stat.dev, ino: stat.ino },
      worktree: role === "builder" ? project : dir("snapshot"),
      ...(needsCopy ? { scratchRepo: dir("scratch/repo") } : {}),
      ...(role === "spec-lead" ? { agentsDir: dir("agents") } : {}),
    };
  } catch (error) {
    rmSync(root, { recursive: true });
    throw error;
  }
}

/** A private object database keeps the reviewed commit's history available without exposing other worktrees. */
export function checkoutSnapshot(git: string, repository: string, sha: string, directory: string) {
  const source = realpathSync(repository);
  const destination = realpathSync(directory);
  if (!/^[a-f0-9]{40}$/.test(sha) || runGit(git, source, ["cat-file", "-t", sha]).toString().trim() !== "commit")
    throw new Error("snapshot requires a full commit id");
  if (overlaps(source, destination) || destination !== directory || readdirSync(destination).length)
    throw new Error("snapshot destination must be separate, canonical and empty");
  const command = (...args: string[]) => runGit(git, destination, ["-c", "core.hooksPath=/dev/null", ...args], 120_000);
  command("init", "--quiet", "--template=");
  command("-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-recurse-submodules", "--", source, sha);
  command("checkout", "-q", "--detach", sha);
  if (command("rev-parse", "HEAD").toString().trim() !== sha) throw new Error("snapshot HEAD mismatch");
}
