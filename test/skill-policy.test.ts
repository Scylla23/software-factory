import { afterEach, beforeEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createAttempt } from "../src/dispatch/attempt";
import { claudeArgs } from "../src/dispatch/claude";
import { codexConfigArgs } from "../src/dispatch/codex";
import { runGit } from "../src/dispatch/git";
import { skillPolicy } from "../src/dispatch/skill-policy";
import { makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => { sb = makeSandbox(); });
afterEach(() => sb.cleanup());

test("Codex permissions close unlisted paths and grant writes to precisely the role roots", () => {
  for (const [role, stage] of [
    ["builder", "build"], ["code-reviewer", "code"], ["security-auditor", "code"],
    ["database-auditor", "code"], ["security-auditor", "spec"], ["spec-reviewer", "spec"],
    ["spec-lead", "spec"], ["triage", "triage"], ["verifier", "judge"],
  ] as const) {
    const dirs = createAttempt({
      runRoot: join(sb.home, "runs"), project: sb.worktree, stateRoot: sb.stateRoot, accountHome: sb.home,
      attemptId: crypto.randomUUID(), role, stage,
    });
    runGit("/usr/bin/git", dirs.worktree, ["init", "-q"]);
    const policy = skillPolicy(role, dirs, [sb.stateRoot], [], [], "/usr/bin/git");
    expect(policy.writable).toEqual([dirs.outDir, dirs.scratchDir, ...(role === "builder" ? [dirs.worktree] : [])]);
    expect(policy.denyWrite).toContain(realpathSync(join(dirs.worktree, ".git")));
    expect(policy.denyRead).toContain(join(dirs.root, "agents"));
    const extra = [dirs.taskDir, dirs.skillsDir, dirs.outDir, dirs.scratchDir];
    const claude = claudeArgs({ prompt: "probe", sessionId: crypto.randomUUID(), model: "haiku", effort: "low", policy, directories: extra });
    expect(claude.filter((_, i) => claude[i - 1] === "--add-dir")).toEqual(extra);
    expect(claude[claude.indexOf("--tools") + 1]!.split(",")).not.toContain("Agent");
    const settings = JSON.parse(claude[claude.indexOf("--settings") + 1]!);
    expect(settings.sandbox.filesystem.denyRead).toContain("/");
    expect(settings.sandbox.filesystem.allowWrite).toEqual(policy.writable);
    expect(settings.permissions.deny).toContain(`Write(/${dirs.taskDir}/**)`);
    expect(settings.permissions.deny.includes(`Write(/${dirs.worktree}/**)`)).toBe(role !== "builder");
    const args = codexConfigArgs(policy);
    expect(args).toContain("agents.enabled=false");
    const profile = args[1]!;
    expect(profile).not.toContain('extends=":workspace"');
    expect(profile).toContain('":root"="none"');
    expect(profile).toContain(`"${dirs.worktree}"="${role === "builder" ? "write" : "read"}"`);
    expect(profile).toContain(`"${dirs.skillsDir}"="read"`);
    expect(profile).toContain(`"${dirs.taskDir}"="read"`);
    expect(profile).toContain(`"${dirs.outDir}"="write"`);
    expect(profile).toContain(`"${dirs.scratchDir}"="write"`);
    expect(() => skillPolicy(role, dirs, [dirs.root], [], [], "/usr/bin/git")).toThrow("mandatory denial");
  }
});
