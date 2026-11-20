import type { Database } from "bun:sqlite";
import { config } from "../../factory.config";
import type { Task } from "../factory/store";
import { redact } from "../github/summary";
import { isRecord } from "../dispatch/jsonl";

export function recordFeedback(db: Database, task: number, kind: "review" | "inline", rows: readonly unknown[]) {
  db.transaction(() => {
    const save = db.query(`INSERT INTO owner_feedback(task,kind,id,sha,body) VALUES(?,?,?,?,?)
      ON CONFLICT(task,kind,id) DO UPDATE SET sha=excluded.sha,body=excluded.body`);
    for (const row of rows) {
      if (!isRecord(row) || !isRecord(row.user) || row.user.id !== config.ownerId
          || typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.body !== "string" || !row.body.trim()) continue;
      save.run(task, kind, row.id, typeof row.commit_id === "string" ? row.commit_id : null, row.body);
    }
  })();
}

/** Optional telemetry runs after the authoritative gate decision, on its own short deadline. */
export async function collectFeedback(db: Database, task: Task, reviews: readonly unknown[], inline: (signal: AbortSignal) => Promise<unknown[]>) {
  function failed(kind: "review" | "inline", error: unknown) {
    const reason = redact(error instanceof Error ? error.message : String(error), 500);
    console.warn(`feedback capture failed for task ${task.id} visit ${task.visit} (${kind}): ${reason}`);
    try {
      db.run("INSERT OR REPLACE INTO feedback_failures(task,visit,kind,reason) VALUES(?,?,?,?)", [task.id,task.visit,kind,reason]);
    } catch (writeError) { console.warn("could not persist feedback failure", writeError); }
  }
  try { recordFeedback(db, task.id, "review", reviews); }
  catch (error) { failed("review", error); }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("inline feedback deadline exceeded")), 2000);
  try {
    // Token resolution may still be pending when fetch first sees the abort signal.
    const deadline = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once:true });
    });
    const rows = await Promise.race([inline(controller.signal), deadline]);
    recordFeedback(db, task.id, "inline", rows);
  } catch (error) { failed("inline", error); }
  finally { clearTimeout(timer); }
}
