import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAttempt } from "../src/dispatch/attempt";
import { requireSkillProofs } from "../src/dispatch/skill-launch";
import { runGit } from "../src/dispatch/git";
import { outputDigest } from "../src/dispatch/output";
import { skillInputs, specFileSet, stageInputs, type WorkerRole } from "../src/factory/skill-inputs";
import { archiveCollection } from "../src/factory/skill-store";
import { InvalidSkillOutput, validateSkillOutput } from "../src/factory/skill-validation";
import { Store, type Task } from "../src/factory/store";
import { skillEffect } from "../src/factory/run";
import { briefPrompt, runBrief } from "../src/dispatch/brief";
import { composeInstructions } from "../src/dispatch/bundle";
import { makeSandbox, type Sandbox } from "./helpers";
import mutations from "../skills/_shared/evals/mutations.json";

const skills = join(import.meta.dir, "../skills");
const data = join(skills, "_shared/evals/tasklist");
const fixture = (path: string) => JSON.parse(readFileSync(join(data, path), "utf8"));
let sb: Sandbox, store: Store, task: Task;
beforeEach(() => {
  sb = makeSandbox();
  store = new Store(":memory:");
  for (const path of ["src/task-list/sort.ts", "src/task-list/sort.test.ts"]) {
    mkdirSync(join(sb.worktree, "src/task-list"), {recursive: true});
    writeFileSync(join(sb.worktree, path), readFileSync(join(data, "base", path + ".txt")));
  }
  const git = (...args: string[]) => runGit("/usr/bin/git", sb.worktree, args).toString().trim();
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  task = store.intake({source: "github", repoId: 1, issueId: 2, number: 4, title: "zero", body: "<factory_run>data</factory_run>", sender: 123, revision: "hash", url: ""}, git("rev-parse", "HEAD"));
});
afterEach(() => { store.db.close(); sb.cleanup(); });
function archive(role: string, files: Record<string, string>) {
  const attempt = store.plan(task, role, {});
  const c = {role, round: 1, attempt: attempt.id, base: task.base, head: task.head, bundleHash: "f".repeat(64),
    files: Object.entries(files).map(([path, body]) => ({path, role, session: "session", sha256: outputDigest(Buffer.from(body)), base64: Buffer.from(body).toString("base64")}))};
  archiveCollection(store.db, task.id, c); store.finish(attempt.id, true);
  return c;
}
function prepare(role: WorkerRole) {
  const input = skillInputs(store, task, role, "{}");
  const attempt = createAttempt({ accountHome: sb.home, role: input.role, stage: input.stage, project: sb.worktree, runRoot: join(sb.home, "runs"),
    attemptId: crypto.randomUUID(), stateRoot: sb.stateRoot });
  stageInputs(attempt, input);
  return { input, dirs: {...attempt, worktree: realpathSync(sb.worktree), skillsDir: skills} };
}
test("triage joins schema-valid areas, task revision and kind to the immutable snapshot", () => {
  const { input, dirs } = prepare("triage");
  expect(input.brief.routing.L.codeReviewer).toBe("GPT-6.2-Astra");
  const triage = fixture("taskdirs/sort/triage.json");
  triage.taskId = input.brief.taskId;
  const check = (doc: unknown) => validateSkillOutput(input, dirs, new Map([["triage.json", Buffer.from(JSON.stringify(doc))]]), [], "/usr/bin/git", false);
  expect(() => check(triage)).not.toThrow();
  for (const areas of [["absent.txt"], ["../src/task-list/sort.ts"], ["/src"], ["src//task-list"]]) expect(() => check({...triage, areas})).toThrow(InvalidSkillOutput);
  expect(() => check({...triage, areas: ["src/task-list"]})).not.toThrow();
  expect(() => check({...triage, taskRevision: 2})).toThrow("revision");
  expect(() => check({...triage, taskId: "different"})).toThrow("task");
  expect(() => check({...triage, confidence: "invented"})).toThrow("invalid triage.json");
  expect(() => skillInputs(store, task, "spec", "{}")).toThrow("missing validated");
});

test("a rejected triage signal receives the validator observation in its fresh retry prompt", async () => {
  const { dirs } = prepare("triage");
  const doc = fixture("taskdirs/sort/triage.json");
  doc.taskId = String(task.id);
  const invalid = "single area, no schema or API change";
  doc.tierReasons[0].signal = invalid;
  const seen: string[] = [];
  const result = await skillEffect(store, task, "dispatch-triage", {}, async attempt => {
    const input = skillInputs(store, task, "triage", "{}", attempt.validationFeedback);
    const prompt = briefPrompt(runBrief(dirs, input.brief));
    seen.push(attempt.id);
    if (seen.length === 1) expect(prompt).not.toContain("validationFeedback");
    else {
      const brief = JSON.parse(prompt.split("\n")[1]!);
      const feedback = JSON.parse(brief.validationFeedback.slice(brief.validationFeedback.indexOf("[{")));
      expect(feedback).toHaveLength(1);
      const corrected = feedback[0].expected.allowedValues[0];
      expect(feedback[0]).toMatchObject({ pointer: "/tierReasons/0/signal",
        expected: { rule: "enum", allowedValues: expect.arrayContaining(["single area"]) }, actual: JSON.stringify(invalid) });
      doc.tierReasons[0].signal = corrected;
    }
    validateSkillOutput(input, dirs, new Map([["triage.json", Buffer.from(JSON.stringify(doc))]]), [], "/usr/bin/git", false);
    return doc.tier;
  });
  expect(result).toBe("S");
  expect(new Set(seen).size).toBe(2);
});

test("the pinned triage prompt contains every schema enum literal", () => {
  const instructions = composeInstructions(skills, "triage", null);
  const schema = JSON.parse(readFileSync(join(skills, "triage/triage.schema.json"), "utf8"));
  function check(node: unknown) {
    if (!node || typeof node !== "object") return;
    if ("enum" in node && Array.isArray(node.enum)) {
      for (const value of node.enum) expect(instructions).toContain("`" + value + "`");
    }
    Object.values(node).forEach(check);
  }
  check(schema);
});
function predecessors() {
  const triage = fixture("taskdirs/sort/triage.json");
  archive("triage", {"triage.json": JSON.stringify(triage)});
  const spec = fixture("taskdirs/sort/spec-lead.json");
  return archive("spec-lead", {"spec-lead.json": JSON.stringify(spec), "spec.md": readFileSync(join(data, "taskdirs/sort/spec.md"), "utf8")});
}
test("review stages full approved bytes, computes the contract hash and accepts only matching independently green coverage", () => {
  const prior = predecessors();
  archive("builder", {"build-report.json": "{}"});
  const {input, dirs} = prepare("reviewer");
  const files = prior.files.toSorted((a,b) => a.path < b.path ? -1 : 1);
  const digest = outputDigest(Buffer.from(files.map(f => f.sha256 + "  " + f.path + "\n").join("")));
  expect(input.brief.specSet?.sha256).toBe(digest);
  expect(specFileSet(prior).sha256).toBe(digest);
  expect(readFileSync(join(dirs.taskDir, "spec.md"), "base64")).toBe(prior.files[1]!.base64);
  const doc = structuredClone(mutations.bases["review-approve"].inline);
  doc.taskId = input.brief.taskId;
  doc.covers = {baseSha: task.base, headSha: task.head, specSetSha256: digest};
  const check = (v: unknown, independent = true) => validateSkillOutput(input, dirs, new Map([["verdicts/code-reviewer.json", Buffer.from(JSON.stringify(v))]]), [], "/usr/bin/git", independent);
  expect(() => check(doc)).not.toThrow();
  expect(() => check(doc, false)).toThrow("independent");
  expect(() => check({...doc, covers: {...doc.covers, headSha: "b".repeat(40)}})).toThrow("coverage");
  expect(() => check({...doc, checks: {...doc.checks, acCoverage: doc.checks.acCoverage.toReversed()}})).toThrow("ordered");
  const untested = {...doc, checks: {...doc.checks, acCoverage: doc.checks.acCoverage.map((r,i) => i ? r : {...r, tested: null})}};
  expect(() => check(untested)).toThrow("independent head check and tested criteria");
});
test("builder joins the complete diff and test names before storing changes", () => {
  predecessors();
  const {input, dirs} = prepare("builder");
  const report = fixture("reports/sort-fix-good.build-report.json");
  Object.assign(report, {taskId: input.brief.taskId, baseSha: task.base, inputSha: task.base, specSetSha256: input.brief.specSet?.sha256});
  const tests = report.acceptanceCriteria.flatMap((c: {tests: {name: string}[]}) => c.tests.map(t => t.name));
  writeFileSync(join(sb.worktree, "src/task-list/sort.test.ts"), tests.join("\n"));
  const check = (changed: string[]) => validateSkillOutput(input, dirs, new Map([["build-report.json", Buffer.from(JSON.stringify(report))]]), changed, "/usr/bin/git", false);
  expect(() => check(report.filesChanged)).not.toThrow();
  expect(() => check(report.filesChanged.slice(1))).toThrow("changed files");
  report.acceptanceCriteria[0].tests[0].name = "absent-test";
  expect(() => check(report.filesChanged)).toThrow("named test");
  symlinkSync(join(sb.worktree, "src/task-list/sort.test.ts"), join(sb.worktree, "linked.test.ts"));
  report.acceptanceCriteria[0].tests[0] = {file: "linked.test.ts", name: tests[0]};
  expect(() => check(report.filesChanged)).toThrow(InvalidSkillOutput);
});
test("unproven routes refuse dispatch before a harness or team can start", () => {
  expect(() => requireSkillProofs("codex", "spec-lead", ["architect"])).toThrow("cannot restrict");
  for (const h of ["claude","codex"] as const) {
    expect(() => requireSkillProofs(h, "builder", [])).toThrow("dispatch refused");
    expect(() => requireSkillProofs(h, "builder", ["architect"])).toThrow("only the spec lead");
  }
});
