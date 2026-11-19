import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deterministicBatchOne, exposesAnswer, flattenCases, judgeGrades, type Check } from "../scripts/batch-one-cases";
import type { runBrief } from "../src/dispatch/brief";

const skills = join(import.meta.dir, "../skills");
const fixture = join(skills, "_shared/evals/tasklist/taskdirs/sort");
const lead = JSON.parse(readFileSync(join(skills, "spec-lead/evals/evals.json"), "utf8")).cases;
const check = (id: string, kind: Check["kind"] = "deterministic"): Check => ({ id, kind, check: id });

test("the spec grade compares each acceptance criterion to the digest-bound document and the staged task", () => {
  const spec = readFileSync(join(fixture, "spec.md"));
  const result = readFileSync(join(fixture, "spec-lead.json"));
  const taskId = JSON.parse(result.toString()).taskId;
  const files = new Map([
    ["spec-lead.json", result],
    ["spec.md", spec],
  ]);
  const brief = { taskId, role: "spec-lead", routing: { S: { builder: "Sol 6.2", codeReviewer: "Opus 5.5" } } } as ReturnType<
    typeof runBrief
  >;
  const row = flattenCases(lead)[0]!;
  const context = {
    ...row,
    skills,
    files,
    brief,
    clean: true,
    inspected: true,
    children: 0,
    tracked: new Set(["src/task-list/sort.ts", "src/task-list/sort.test.ts"]),
  };
  expect(Object.values(deterministicBatchOne(context))).not.toContain(false);
  files.set(
    "spec.md",
    Buffer.from(spec.toString().replace("### AC-2:", "### AC-1:").replace("src/task-list/sort.ts", "src/absent.ts")),
  );
  expect(deterministicBatchOne(context)).toMatchObject({ "ac-shape": false, "paths-exist": false });
  files.set("spec-lead.json", Buffer.from('{"acceptanceCriteria":"invalid"}'));
  expect(Object.values(deterministicBatchOne(context))).not.toContain(true);
  files.set("spec-lead.json", result);
  expect(deterministicBatchOne({ ...context, brief: { ...brief, taskId: "another" } })["result-schema"]).toBe(false);
});

test("judge grading rejects a duplicate id, negative answer and a quote absent from the candidate", () => {
  const files = new Map([["spec.md", Buffer.from("The response has status 404.")]]);
  const checks = [check("status", "judge")];
  const grade = (answers: unknown[]) => judgeGrades(answers, checks, files).status;
  const row = { id: "status", yes: true, quote: "status 404" };
  expect(grade([row])).toBe(true);
  for (const answers of [
    [],
    [row, row],
    [{ ...row, yes: false }],
    [{ ...row, quote: "status 401" }],
    [{ ...row, quote: " " }],
    [{ ...row, id: "different" }],
  ])
    expect(grade(answers)).toBe(false);
});

test("each case keeps its own rubric and a disclosed planted classification prevents a blind launch", () => {
  const rows = flattenCases(lead);
  expect(rows.length).toBe(4);
  expect(rows[0]!.checks.some((c) => c.id === "inherited")).toBe(false);
  expect(rows[1]!.checks.some((c) => c.id === "inherited")).toBe(true);
  const promotion = lead[1].input.files["triage.json"].inline;
  expect(promotion.tier).toBe("S");
  expect(promotion.riskFlags.migration.value).toBe(false);
  expect(exposesAnswer(lead[1].input.files)).toBe(false);
  expect(exposesAnswer({reason:"PLANTED: deliberately wrong."})).toBe(true);
  expect(exposesAnswer(lead[0].variants[0].input.files)).toBe(false);
});

test("team ordering requires observed completions before both dependents can start", async () => {
  const { observedTeamOrder } = await import("../scripts/batch-one-cases");
  const starts = [
    { role: "architect", started: 1, completed: 3 },
    { role: "infra", started: 4, completed: 7 },
    { role: "frontend", started: 5, completed: 8 },
    { role: "threat-modeler", started: 9, completed: 11 },
  ];
  expect(observedTeamOrder(starts)).toBe(true);
  for (const first of [
    { role: "architect", started: 1, completed: null },
    { role: "architect", started: 1, completed: 4 },
    { role: "infra", started: 1, completed: 3 },
  ])
    expect(observedTeamOrder([first, ...starts.slice(1)])).toBe(false);
  expect(observedTeamOrder([...starts.slice(0, 3), { ...starts[3]!, started: 8 }])).toBe(false);
});
