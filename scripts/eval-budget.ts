// This database belongs to the approved evaluation batch, separate from factory tasks and production usage.
import { chmodSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { ClaudeUsage } from "../src/dispatch/types";

export const batchLimit = { input: 800_000, output: 120_000 } as const;
export type Estimate = { input: number; output: number; turns: number };
const initial: Record<string, Estimate> = {
  triage: { input: 30_000, output: 3_000, turns: 12 },
  "spec-lead": { input: 90_000, output: 12_000, turns: 32 },
  "spec-team": { input: 220_000, output: 35_000, turns: 55 },
  judge: { input: 18_000, output: 3_000, turns: 2 },
};

export class EvalBudget {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS trials (key TEXT PRIMARY KEY, revision TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, report TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, trial TEXT NOT NULL, case_key TEXT NOT NULL, model TEXT NOT NULL,
        estimate_input INTEGER NOT NULL, estimate_output INTEGER NOT NULL,
        actual_input INTEGER, actual_output INTEGER, usage TEXT, outcome TEXT,
        started TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`);
  }
  totals() {
    return this.db
      .query<{ input: number; output: number; pending: number }, []>(
        `SELECT COALESCE(SUM(actual_input),0) AS input,
      COALESCE(SUM(actual_output),0) AS output, COUNT(*) - COUNT(actual_input) AS pending FROM sessions`,
      )
      .get()!;
  }
  reserve(id: string, trial: string, key: string, kind: string, model: string, register?: { revision: string; id: string }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const fallback = initial[kind];
      const approvedModel = kind === "judge" || kind === "triage" ? "claude-sonnet-5-5" : "claude-opus-5-5";
      if (!fallback || !Object.hasOwn(initial, kind) || model !== approvedModel)
        throw new Error("unapproved Claude evaluation role or model");
      const total = this.totals();
      if (total.pending) throw new Error("unsettled Claude usage in this batch");
      const prior = this.db
        .query<{ i: number | null; o: number | null }, [string]>(
          "SELECT MAX(actual_input) AS i, MAX(actual_output) AS o FROM sessions WHERE case_key=?",
        )
        .get(key)!;
      const input = prior.i ?? fallback.input,
        output = prior.o ?? fallback.output;
      if (total.input + input > batchLimit.input || total.output + output > batchLimit.output)
        throw new Error("batch token stop rule reached");
      this.db.run("INSERT INTO sessions(id,trial,case_key,model,estimate_input,estimate_output) VALUES(?,?,?,?,?,?)", [
        id,
        trial,
        key,
        model,
        input,
        output,
      ]);
      if (register) this.db.run("INSERT INTO trials VALUES(?,?,?,'started',NULL)", [trial, register.revision, register.id]);
      // Upper short-session price including long-cache writes at the step 8 price snapshot.
      const rate = model === "claude-opus-5-5" ? { i: 8, o: 20 } : { i: 4, o: 10 };
      this.db.exec("COMMIT");
      return { maxTurns: fallback.turns, maxUsd: Math.max(0.01, Math.ceil((input * rate.i + output * rate.o) / 10000) / 100) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  settle(id: string, usage: ClaudeUsage | null, outcome: string) {
    if (!usage || !Object.keys(usage.byModel).length) throw new Error("unmeasured Claude session; batch stopped");
    let input = 0,
      output = 0;
    for (const u of Object.values(usage.byModel)) {
      const counts = [u.inputTokens, u.cacheReadInputTokens, u.cacheCreationInputTokens, u.outputTokens];
      if (!counts.every((v) => Number.isSafeInteger(v) && v >= 0)) throw new Error("invalid Claude usage; batch stopped");
      input += u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
      output += u.outputTokens;
    }
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input === 0)
      throw new Error("incomplete Claude usage; batch stopped");
    if (
      this.db.run("UPDATE sessions SET actual_input=?,actual_output=?,usage=?,outcome=? WHERE id=? AND actual_input IS NULL", [
        input,
        output,
        JSON.stringify(usage),
        outcome,
        id,
      ]).changes !== 1
    )
      throw new Error("unknown or settled Claude evaluation session");
    const actual = this.totals();
    return {
      ...actual,
      overshootInput: Math.max(0, actual.input - batchLimit.input),
      overshootOutput: Math.max(0, actual.output - batchLimit.output),
    };
  }
}
