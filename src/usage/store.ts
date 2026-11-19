import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeStream } from "../dispatch/claude";
import { parseCodexEvents } from "../dispatch/codex";
import { readJsonl } from "../dispatch/jsonl";
import type { Harness } from "../dispatch/types";
import type { Task } from "../factory/store";
import { primary, type Capture, type RunUsage } from "./capture";
import { captureRun } from "./sessions";

export function modelFlag(requested: string, observed: string | null) {
  return !observed ? "unknown" : requested !== observed ? "mismatch" : "match";
}

export function legacyCapture(usage: string | null, observed: string | null, outcome: string) {
  let value: unknown = null;
  try { value = JSON.parse(usage ?? "null"); } catch { /* Legacy or damaged receipt. */ }
  return primary(value, observed, outcome);
}

function putCapture(db: Database, id: string, requested: string, observed: string | null, capture: Capture) {
  db.run("INSERT OR REPLACE INTO usage_captures(attempt,model_flag,capture) VALUES(?,?,?)",
    [id, modelFlag(requested, observed), JSON.stringify(capture)]);
}

/** Called inside the store's schema transaction, including the backfill on an existing v1 database. */
export function migrateUsage(db: Database) {
  db.exec(`
    CREATE TABLE usage_captures(attempt TEXT PRIMARY KEY REFERENCES audit(attempt), model_flag TEXT NOT NULL,
      capture TEXT NOT NULL);
    CREATE TABLE owner_feedback(task INTEGER NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL,
      id INTEGER NOT NULL, sha TEXT, body TEXT NOT NULL, PRIMARY KEY(task,kind,id));
  `);
  type Old = { attempt: string; requested_model: string; observed_model: string | null; usage: string | null; outcome: string };
  for (const row of db.query<Old, []>("SELECT attempt,requested_model,observed_model,usage,outcome FROM audit").all()) {
    putCapture(db, row.attempt, row.requested_model, row.observed_model, legacyCapture(row.usage, row.observed_model, row.outcome));
  }
  db.exec("PRAGMA user_version=2");
}

export interface MeterJob {
  id: string;
  prompt: string;
  base: string;
  head: string;
  agent: { harness: Harness; effort: string; model: string };
}

export async function recordUsage(db: Database, task: Task, job: MeterJob, run: RunUsage, root: string) {
  const { capture, session, observed } = await captureRun(run, root);
  db.transaction(() => {
    // Receipt adoption is idempotent. A later final receipt can settle an uncertain supervisor.
    const record = db.run(`INSERT INTO audit(attempt,task,stage,session,requested_model,observed_model,effort,prompt_revision,base,head,outcome,usage)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attempt) DO UPDATE SET session=excluded.session,
      observed_model=excluded.observed_model,requested_model=excluded.requested_model,outcome=excluded.outcome,usage=excluded.usage WHERE audit.outcome='uncertain'`,
      [job.id, task.id, task.state, session, run.requestedModel, observed, job.agent.effort,
        createHash("sha256").update(job.prompt).digest("hex"), job.base, job.head, run.outcome, JSON.stringify(run.usage)]);
    if (record.changes) putCapture(db, job.id, run.requestedModel, observed, capture);
  }).immediate();
}

// The published snapshot survives config edits between dispatch and receipt adoption.
export function meteredJob(dir: string, intended: MeterJob): MeterJob {
  const path = join(dir, "job.json");
  if (!existsSync(path)) return intended;
  const stored = JSON.parse(readFileSync(path, "utf8"));
  if (stored.id !== intended.id || stored.base !== intended.base || stored.head !== intended.head || stored.prompt !== intended.prompt)
    throw new Error("worker accounting identity changed");
  return { ...intended, agent: stored.agent ?? intended.agent };
}

export async function recordInterrupted(db: Database, task: Task, job: MeterJob, dir: string, stateRoot: string) {
  if (db.query("SELECT 1 FROM audit WHERE attempt=?").get(job.id)) return;
  const harness = job.agent.harness;
  const run: RunUsage = { harness, runId: job.id, requestedModel: job.agent.model, observedModel: null,
    sessionId: null, outcome: "uncertain", usage: null };
  const path = join(dir, job.id + ".stdout.jsonl");
  if (existsSync(path)) {
    if (harness === "claude") {
      const s = await parseClaudeStream(readJsonl(path));
      Object.assign(run, { observedModel: s.observedModel, sessionId: s.sessionId, usage: s.usage, reportedCostUsd: s.reportedCostUsd });
    } else {
      const s = await parseCodexEvents(readJsonl(path));
      Object.assign(run, { sessionId: s.threadId, usage: s.usage });
    }
  }
  await recordUsage(db, task, job, run, stateRoot);
}
