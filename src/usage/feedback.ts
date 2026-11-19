import type { Database } from "bun:sqlite";
import { config } from "../../factory.config";
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
