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
