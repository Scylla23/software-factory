import {mkdtempSync, rmSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import { expect, test } from "bun:test";
import { EvalBudget } from "../scripts/eval-budget";
import type { ClaudeUsage } from "../src/dispatch/types";

const counts = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens: 4,
  cacheCreationInputTokens: 6,
  costUsd: 0.1,
});
const usage = (n: number, o: number): ClaudeUsage => ({
  harness: "claude",
  totalCostUsd: 0.2,
  byModel: { parent: counts(n, o), child: counts(10, 20) },
});
test("batch stops before a session using measured parent, child and cache counts and the largest same-case observation", () => {
  const b = new EvalBudget(":memory:");
  try {
    const reserve = (id: string, key = "case") => b.reserve(id, id, key, "triage", "claude-sonnet-5-5");
    expect(reserve("first").maxTurns).toBe(12);
    expect(() => reserve("another")).toThrow("unsettled");
    expect(() => b.settle("first", null, "uncertain")).toThrow("unmeasured");
    expect(b.settle("first", usage(390000, 54000), "failed")).toMatchObject({ input: 390030, output: 54020, pending: 0 });
    expect(reserve("second").maxUsd).toBeGreaterThan(0);
    expect(b.db.query("SELECT estimate_input FROM sessions WHERE id='second'").get()).toEqual({ estimate_input: 390030 });
    expect(b.settle("second", usage(400000, 56000), "completed")).toMatchObject({ input: 790060, output: 110040 });
    expect(() => reserve("third", "different")).toThrow("stop rule");
    expect(() => reserve("fourth")).toThrow("stop rule");
  } finally {
    b.db.close();
  }
});
test("one estimation overshoot is reported and never enables a subsequent session", () => {
  const b = new EvalBudget(":memory:");
  try {
    b.reserve("a", "judge-1", "judge/one", "judge", "claude-sonnet-5-5");
    expect(b.settle("a", usage(800000, 120000), "completed")).toMatchObject({ overshootInput: 30, overshootOutput: 20 });
    expect(() => b.reserve("b", "judge-2", "judge/two", "judge", "claude-sonnet-5-5")).toThrow("stop rule");
  } finally {
    b.db.close();
  }
});

test("CLI gets per-session turn and dollar backstops, with malformed limits rejected before launch", async () => {
  const { claudeArgs } = await import("../src/dispatch/claude");
  const input = {
    model: "claude-haiku-5-5",
    effort: "low" as const,
    prompt: "",
    sessionId: crypto.randomUUID(),
    policy: { writable: [], readable: [], denyRead: [], denyWrite: [] },
  };
  const args = claudeArgs({ ...input, evaluationLimits: { maxTurns: 12, maxUsd: 1.2 } });
  expect(args.slice(args.indexOf("--max-turns"), args.indexOf("--max-turns") + 4)).toEqual([
    "--max-turns",
    "12",
    "--max-budget-usd",
    "1.2",
  ]);
  for (const limits of [
    { maxTurns: 0, maxUsd: 1 },
    { maxTurns: 2, maxUsd: Infinity },
    { maxTurns: 2, maxUsd: 0 },
  ])
    expect(() => claudeArgs({ ...input, evaluationLimits: limits })).toThrow("invalid Claude evaluation limits");
});

test("either token dimension alone stops the next session and approvals bind each model to its role", () => {
  for (const [input, output] of [
    [780000, 10],
    [100, 118000],
  ] as const) {
    const b = new EvalBudget(":memory:");
    try {
      expect(() => b.reserve("bad", "t", "new", "triage", "claude-opus-5-5")).toThrow("unapproved");
      b.reserve("a", "t", "case", "triage", "claude-sonnet-5-5");
      b.settle("a", usage(input, output), "completed");
      expect(() => b.reserve("b", "s", "new", "triage", "claude-sonnet-5-5")).toThrow("stop rule");
      expect(b.totals().pending).toBe(0);
    } finally {
      b.db.close();
    }
  }
});

test("a declined reservation leaves no trial and a duplicate trial rolls back its session", () => {
  const b = new EvalBudget(":memory:");
  try {
    const reserve = (id: string, trial: string) =>
      b.reserve(id, trial, "fixture", "triage", "claude-sonnet-5-5", { id, revision: "pin" });
    reserve("one", "case#1");
    expect(() => reserve("two", "case#2")).toThrow("unsettled");
    b.settle("one", usage(100, 20), "completed");
    expect(() => reserve("three", "case#1")).toThrow();
    expect(b.totals().pending).toBe(0);
    expect(b.db.query("SELECT key FROM trials").all()).toEqual([{ key: "case#1" }]);
  } finally {
    b.db.close();
  }
});

test("a stopped batch also bars a cheaper judge after the database is reopened", () => {
  const path = join(mkdtempSync(join(tmpdir(),"factory-eval-stop-")),"usage.sqlite");
  let batch = new EvalBudget(path);
  try {
    batch.reserve("first","case#1","case","triage","claude-sonnet-5-5");
    batch.settle("first",usage(765000,20000),"completed");
    expect(()=>batch.reserve("second","case#2","case","triage","claude-sonnet-5-5")).toThrow("stop rule");
    batch.db.close();
    batch=new EvalBudget(path);
    expect(()=>batch.reserve("judge","case#1","judge","judge","claude-sonnet-5-5")).toThrow("stop rule");
    expect(batch.totals().pending).toBe(0);
  } finally {batch.db.close();rmSync(dirname(path),{recursive:true,force:true});}
});
