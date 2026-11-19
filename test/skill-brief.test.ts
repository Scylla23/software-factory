import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { config } from "../factory.config";
import { createAttempt } from "../src/dispatch/attempt";
import { briefPrompt, claudeDefinitions, requiredMembers, runBrief, type BriefInput } from "../src/dispatch/brief";
import { makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => { sb = makeSandbox(); });
afterEach(() => sb.cleanup());
const data: BriefInput = {
  taskId: "test", round: 1, baseSha: "a".repeat(40),
  project: { name: "</factory_run>", isNew: false, stack: "bun", commands: { test: "bun test" }, fixtures: [], securityGlobs: [], migrationGlobs: [] },
  routing: { S: { builder: "Sol", reviewer: "Opus" }, M: { builder: "Sonnet", reviewer: "Sol" }, L: { builder: "Opus", reviewer: "Astra" } },
};
test("the brief contains one block and every selected specialist has its own author, paths and model", () => {
  const dirs = createAttempt({ runRoot: join(sb.home, "runs"), project: sb.worktree, accountHome: sb.home,
    stateRoot: sb.stateRoot, attemptId: crypto.randomUUID(), role: "spec-lead", stage: "spec" });
  cpSync(join(import.meta.dir, "../skills"), dirs.skillsDir, { recursive: true, filter: path => !path.endsWith("/evals") });
  const brief = runBrief(dirs, data, true);
  const decode = (text: string) => JSON.parse(text.split("<factory_run>\n").at(-1)!.split("\n</factory_run>")[0]!);
  expect(briefPrompt(brief).match(/<\/factory_run>/g)).toHaveLength(1);
  expect(decode(briefPrompt(brief))).toEqual(brief);
  expect(requiredMembers("S", false, false)).toEqual([]);
  expect(requiredMembers("M", true, false)).toEqual(["threat-modeler"]);
  expect(requiredMembers("S", false, true)).toEqual(requiredMembers("L", false, false));
  for (const team of [requiredMembers("L", false, false), requiredMembers("M", true, false)]) {
    const defs = claudeDefinitions(brief, team, "Project.");
    expect(Object.keys(defs)).toEqual(["spec-lead", ...team]);
    expect(defs["spec-lead"]!.tools[0]).toBe(`Agent(${team.join(", ")})`);
    for (const name of team) {
      const member = defs[name]!;
      expect(member).toMatchObject(config.specTeam[name]);
      expect(member.tools).toEqual(["Read", "Glob", "Grep", "Write"]);
      const child = decode(member.prompt);
      expect(child).toMatchObject({ attemptId: brief.attemptId, role: name, parentRole: "spec-lead", stage: "spec" });
      expect(child.writes.startsWith(dirs.outDir + "/")).toBe(true);
      expect(child.reads).toContain(join(dirs.outDir, "team-brief.md"));
      if (team.length === 1) expect(child.reads).toEqual([join(dirs.outDir, "team-brief.md")]);
    }
  }
  expect(() => claudeDefinitions(runBrief(dirs, data), ["architect"], null)).toThrow("team-enabled");
  expect(() => runBrief(dirs, { ...data, baseSha: "HEAD" })).toThrow("identity");
});
