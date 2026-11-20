import { expect, test } from "bun:test";
import { DollarBudget } from "../scripts/eval-dollar-budget";
import type { ClaudeUsage } from "../src/dispatch/types";

const usage = (dollars: number): ClaudeUsage => ({
  harness: "claude",
  totalCostUsd: dollars,
  byModel: Object.fromEntries(
    ["parent", "child"].map((m) => [
      m,
      { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 10, cacheCreationInputTokens: 1, costUsd: dollars / 2 },
    ]),
  ),
});
test("batch two serializes spend and stops at the worst observed same-case charge", () => {
  const ledger = new DollarBudget(":memory:");
  const reserve = (id: string, key = "lead") => ledger.reserve(id, id, key, "spec-team", "claude-opus-5-5");
  try {
    expect(reserve("1").maxUsd).toBe(4);
    expect(() => reserve("2")).toThrow("unsettled");
    expect(() => ledger.settle("1", null, "uncertain")).toThrow("unmeasured");
    expect(ledger.settle("1", usage(9), "completed").totalUsd).toBe(9);
    expect(reserve("2").maxUsd).toBe(9);
    expect(ledger.settle("2", usage(9), "failed").totalUsd).toBe(18);
    expect(() => reserve("3")).toThrow("dollar stop");
    expect(() => reserve("4", "cheap")).toThrow("dollar stop");
    expect(ledger.totals().pending).toBe(0);
  } finally {
    ledger.db.close();
  }
});
test("judges cannot reserve an unapproved model and overshoot stops even an inexpensive judge", () => {
  const ledger = new DollarBudget(":memory:");
  try {
    expect(() => ledger.reserve("bad", "x", "x", "judge", "claude-opus-5-5")).toThrow("unapproved");
    ledger.reserve("ok", "x", "x", "judge", "claude-sonnet-5-5");
    expect(ledger.settle("ok", usage(26), "completed").overshootUsd).toBe(1);
    expect(() => ledger.reserve("next", "y", "y", "judge", "claude-sonnet-5-5")).toThrow("dollar stop");
  } finally {
    ledger.db.close();
  }
});

test("the owner's $5 completion allowance persists and cannot reset after a budget stop", () => {
  const ledger = new DollarBudget(":memory:");
  const reserve = (id: string) => ledger.reserve(id, id, id, "judge", "claude-sonnet-5-5");
  try {
    reserve("prior");
    ledger.db.run("INSERT INTO batch_stop VALUES(1,?)", ["owner handover: no new sessions"]);
    expect(() => ledger.activateCompletionBudget()).toThrow("unsettled");
    ledger.settle("prior", usage(18), "completed");
    expect(ledger.activateCompletionBudget()).toBe(23);
    reserve("new");
    ledger.settle("new", usage(4.9), "completed");
    ledger.db.run("INSERT INTO batch_stop VALUES(1,?)", ["owner handover: no new sessions"]);
    expect(ledger.activateCompletionBudget()).toBe(23);
    expect(() => reserve("over")).toThrow("dollar stop");
    expect(ledger.db.query("SELECT reason FROM batch_stop").get()).toEqual({ reason: "over" });
    expect(ledger.activateCompletionBudget()).toBe(23);
    expect(() => reserve("still stopped")).toThrow("dollar stop");
  } finally {
    ledger.db.close();
  }
});

test("team notification accounting joins the same session, index and unchanged model charge", async () => {
  const { repeatedTeamCharge } = await import("../scripts/eval-measurements");
  const session = crypto.randomUUID(),
    model = "claude-opus-5-5";
  const init = { type: "system", subtype: "init", session_id: session, model };
  const models = { [model]: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.5 } };
  const first = {
    type: "result",
    session_id: session,
    uuid: crypto.randomUUID(),
    result_index: 0,
    total_cost_usd: 0.5,
    modelUsage: models,
    model_usage_since_last_result: models,
  };
  const next = {
    ...first,
    uuid: crypto.randomUUID(),
    result_index: 1,
    origin: { kind: "task-notification", producer: "session-task" },
    model_usage_since_last_result: {},
  };
  async function charge(last: object, initial: object = first) {
    async function* records() {
      for (const [i, value] of [init, init, initial, last].entries()) yield { kind: "record" as const, line: i + 1, value: { ...value } };
    }
    return repeatedTeamCharge(records(), session, model);
  }
  expect((await charge(next))?.totalCostUsd).toBe(0.5);
  for (const change of [
    { origin: null },
    { result_index: 2 },
    { session_id: crypto.randomUUID() },
    { uuid: first.uuid },
    { model_usage_since_last_result: models },
    { modelUsage: {} },
    { total_cost_usd: 1 },
  ])
    expect(await charge({ ...next, ...change })).toBeNull();
  expect(await charge(next, { ...first, model_usage_since_last_result: {} })).toBeNull();
});
