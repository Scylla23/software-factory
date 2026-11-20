import { chmodSync } from "node:fs";
import { Database } from "bun:sqlite";
import { primary } from "../src/usage/capture";
import type { ClaudeUsage } from "../src/dispatch/types";

const million = 1_000_000;
const originalCeiling = 25 * million;
const completionAllowance = 5 * million;
const handover = "owner handover: no new sessions";
// Initial worst-case estimates include cache writes, output and native children where applicable.
const backstops: Record<string, [string, number, number]> = {
  judge: ["claude-sonnet-5-5", 0.15, 2],
  "spec-lead": ["claude-opus-5-5", 1.5, 32],
  "spec-team": ["claude-opus-5-5", 4, 55],
  "code-reviewer": ["claude-opus-5-5", 2, 32],
  "database-auditor": ["claude-opus-5-5", 2, 32],
  architect: ["claude-opus-5-5", 2, 32],
  infra: ["claude-sonnet-5-5", 1, 32],
  frontend: ["claude-sonnet-5-5", 1, 32],
  "threat-modeler": ["claude-sonnet-5-5", 1, 32],
  verifier: ["claude-sonnet-5-5", 1, 32],
};

export class DollarBudget {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS batch_stop(id INTEGER PRIMARY KEY CHECK(id=1), reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS completion_budget(id INTEGER PRIMARY KEY CHECK(id=1), baseline INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS trials(key TEXT PRIMARY KEY, revision TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, report TEXT);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, trial TEXT NOT NULL, case_key TEXT NOT NULL, kind TEXT NOT NULL,
        model TEXT NOT NULL, estimate_micro INTEGER NOT NULL, actual_micro INTEGER, usage TEXT, outcome TEXT);`);
  }
  totals() {
    return this.db
      .query<{ committed: number; pending: number }, []>(
        "SELECT COALESCE(SUM(actual_micro),0) AS committed,COUNT(*)-COUNT(actual_micro) AS pending FROM sessions",
      )
      .get()!;
  }
  private ceiling() {
    const row = this.db.query<{ baseline: number }, []>("SELECT baseline FROM completion_budget WHERE id=1").get();
    return row ? row.baseline + completionAllowance : originalCeiling;
  }
  activateCompletionBudget() {
    return this.atomic(() => {
      const total = this.totals();
      if (total.pending) throw new Error("unsettled batch two session");
      if (this.db.query("SELECT id FROM completion_budget").get()) return this.ceiling() / million;
      const stop = this.db.query<{ reason: string }, []>("SELECT reason FROM batch_stop WHERE id=1").get();
      if (stop?.reason !== handover) throw new Error("completion budget requires the owner handover stop");
      this.db.run("INSERT INTO completion_budget VALUES(1,?)", [total.committed]);
      this.db.run("DELETE FROM batch_stop WHERE id=1");
      return this.ceiling() / million;
    });
  }
  private atomic<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  reserve(id: string, trial: string, key: string, kind: string, model: string, register?: { revision: string; id: string }) {
    if (!Object.hasOwn(backstops, kind) || backstops[kind]![0] !== model) throw new Error("unapproved batch two model or role");
    const [, estimate, turns] = backstops[kind]!;
    const result = this.atomic(() => {
      if (this.db.query("SELECT id FROM batch_stop").get()) return null;
      const total = this.totals();
      if (total.pending) throw new Error("unsettled batch two session");
      const prior = this.db
        .query<{ cost: number | null }, [string, string, string]>(
          "SELECT MAX(actual_micro) AS cost FROM sessions WHERE case_key=? AND kind=? AND model=?",
        )
        .get(key, kind, model)!.cost;
      const limit = Math.max(prior ?? 0, Math.ceil(estimate * million));
      const ceiling = this.ceiling();
      if (total.committed + limit > ceiling) {
        this.db.run("INSERT INTO batch_stop VALUES(1,?)", [key]);
        return null;
      }
      this.db.run("INSERT INTO sessions(id,trial,case_key,kind,model,estimate_micro) VALUES(?,?,?,?,?,?)", [
        id,
        trial,
        key,
        kind,
        model,
        limit,
      ]);
      if (register) this.db.run("INSERT INTO trials VALUES(?,?,?,'started',NULL)", [trial, register.revision, register.id]);
      return { maxUsd: limit / million, maxTurns: turns };
    });
    if (!result) throw new Error("batch dollar stop rule reached");
    return result;
  }
  settle(id: string, usage: ClaudeUsage | null, outcome: string) {
    const capture = primary(usage, null, outcome);
    if (
      capture.coverage !== "complete" ||
      !capture.lines.length ||
      capture.costUsd === null ||
      !Number.isFinite(capture.costUsd) ||
      capture.costUsd < 0
    )
      throw new Error("unmeasured batch two session");
    const micro = Math.ceil(capture.costUsd * million);
    return this.atomic(() => {
      if (
        this.db.run("UPDATE sessions SET actual_micro=?,usage=?,outcome=? WHERE id=? AND actual_micro IS NULL", [
          micro,
          JSON.stringify(usage),
          outcome,
          id,
        ]).changes !== 1
      )
        throw new Error("unknown or settled batch two session");
      const total = this.totals();
      const ceiling = this.ceiling();
      if (total.committed > ceiling) this.db.run("INSERT OR IGNORE INTO batch_stop VALUES(1,?)", [id]);
      return {
        costUsd: capture.costUsd,
        totalUsd: total.committed / million,
        overshootUsd: Math.max(0, total.committed - ceiling) / million,
      };
    });
  }
}
