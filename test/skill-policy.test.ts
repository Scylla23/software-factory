import { afterEach, beforeEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAttempt } from "../src/dispatch/attempt";
import { claudeArgs } from "../src/dispatch/claude";
import { codexConfigArgs } from "../src/dispatch/codex";
import { runGit } from "../src/dispatch/git";
import { checkDiscoverySources, discoveryGlobs } from "../src/dispatch/discovery";
import { requiredProofs } from "../src/dispatch/skill-launch";
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
    if (dirs.scratchRepo) runGit("/usr/bin/git", dirs.scratchRepo, ["init", "-q"]);
    const policy = skillPolicy(dirs, [sb.stateRoot], [], [], "/usr/bin/git");
    expect(policy.writable).toEqual([dirs.outDir, dirs.scratchDir, ...(role === "builder" ? [dirs.worktree] : [])]);
    expect(policy.denyWrite).toContain(realpathSync(join(dirs.worktree, ".git")));
    expect(policy.denyRead).toContain(join(dirs.root, "agents"));
    const extra = [dirs.taskDir, dirs.skillsDir, dirs.outDir, dirs.scratchDir];
    const claude = claudeArgs({ prompt: "probe", sessionId: crypto.randomUUID(), model: "haiku", effort: "low", policy, directories: extra });
    expect(claude.filter((_, i) => claude[i - 1] === "--add-dir")).toEqual(extra);
    expect(claude[claude.indexOf("--tools") + 1]!.split(",")).not.toContain("Agent");
    const settings = JSON.parse(claude[claude.indexOf("--settings") + 1]!);
    expect(claude[claude.indexOf("--tools") + 1]!.split(",")).not.toContain("Bash");
    expect(settings.permissions.deny).toContain("Bash");
    expect(requiredProofs("claude",role,[],stage).join(" ")).not.toMatch(/S4|R1 direct shell|S2/);
    expect(requiredProofs("claude",role,[],stage).includes("builder command execution with closed reads")).toBe(role==="builder");
    for(const pattern of discoveryGlobs) for(const tool of ["Write","Edit","Read"]) expect(settings.permissions.deny).toContain(tool+"(//"+pattern+")");
    expect(settings.sandbox.filesystem.denyRead).toContain("/");
    expect(settings.sandbox.filesystem.allowWrite).toEqual(policy.writable);
    expect(settings.permissions.deny).toContain(`Write(/${dirs.taskDir}/**)`);
    expect(settings.permissions.deny.includes(`Write(/${dirs.worktree}/**)`)).toBe(role !== "builder");
    const args = codexConfigArgs(policy);
    expect(args).toContain("agents.enabled=false");
    const profile = args[1]!;
    for(const root of [dirs.outDir,dirs.scratchDir,dirs.worktree,dirs.taskDir,dirs.skillsDir]) {
      for(const pattern of discoveryGlobs) expect(profile).toContain(JSON.stringify(root+"/"+pattern)+'="none"');
    }
    expect(profile).not.toContain('extends=":workspace"');
    expect(profile).toContain('":root"="none"');
    expect(profile).toContain(`"${dirs.worktree}"="${role === "builder" ? "write" : "read"}"`);
    expect(profile).toContain(`"${dirs.skillsDir}"="read"`);
    expect(profile).toContain(`"${dirs.taskDir}"="read"`);
    expect(profile).toContain(`"${dirs.outDir}"="write"`);
    expect(profile).toContain(`"${dirs.scratchDir}"="write"`);
    expect(() => skillPolicy(dirs, [dirs.root], [], [], "/usr/bin/git")).toThrow("mandatory denial");
  }
});

test("Claude checks submitted agent types in addition to the prelaunch allowlist", async () => {
  const {parseClaudeStream} = await import("../src/dispatch/claude");
  async function check(role: string, parent: string | null, members: string[]) {
    async function* records() {
      const values = [
        {type: "system", subtype: "init", session_id: "lead", tools: members.length ? ["Task","Read"] : ["Read"]},
        {type: "assistant", parent_tool_use_id: parent, message: {content: [{type: "tool_use", name: "Agent", input: {subagent_type: role}}]}},
        {type: "result", subtype: "success", is_error: false, result: "done", session_id: "lead"},
      ];
      for (const [i, value] of values.entries()) yield {kind: "record" as const, line: i+1, value};
    }
    return (await parseClaudeStream(records(), {session: "lead", members})).succeeded;
  }
  expect(await check("architect", null, ["architect"])).toBe(true);
  expect(await check("fork", null, ["architect"])).toBe(false);
  expect(await check("architect", "parent-agent", ["architect"])).toBe(false);
  expect(await check("architect", null, [])).toBe(false);
});

test("launch proof requirements preserve owner protections without gating on D3 or R3 receipts", () => {
  expect(requiredProofs("claude", "spec-lead", ["architect"], "spec")).toEqual(["factory personal-source probe"]);
  for (const role of ["code-reviewer", "database-auditor", "security-auditor"] as const) {
    expect(requiredProofs("claude", role, [], "code")).toEqual(["factory personal-source probe"]);
  }
  expect(requiredProofs("codex", "code-reviewer", [], "code")).toEqual([
    "factory personal-source probe",
    "native file tool write-root matrix for code-reviewer",
  ]);
});

test("a discovery source cannot share its bytes with an independently writable filename", () => {
  const dir=join(sb.worktree,".claude","rules");mkdirSync(dir,{recursive:true});
  const ordinary=join(sb.worktree,"ordinary.md");writeFileSync(ordinary,"fixture");
  const source=join(dir,"guide.md");
  symlinkSync(ordinary,source);
  expect(()=>checkDiscoverySources(sb.worktree)).toThrow("unsafe alias");
  rmSync(source);linkSync(ordinary,source);
  expect(()=>checkDiscoverySources(sb.worktree)).toThrow("unsafe alias");
  rmSync(source);writeFileSync(source,"fixture");
  expect(()=>checkDiscoverySources(sb.worktree)).not.toThrow();
});
