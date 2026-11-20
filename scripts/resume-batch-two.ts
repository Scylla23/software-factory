// Explicit entry point for the successor. Preserve the original reservation and frozen contestant.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../factory.config";
import { loadDispatchConfig } from "../src/dispatch";
import { assertPrivateDir } from "../src/dispatch/config";
import { sessionUuid } from "../src/dispatch/validation";
import { judgeGrades } from "./batch-one-cases";
import { runCodexJudge } from "./eval-codex-judge";
import { DollarBudget } from "./eval-dollar-budget";

if (process.argv.length !== 3 || process.argv[2] !== "--release-owner-handover") throw new Error("explicit handover release required");
const d = loadDispatchConfig({ agentWriteRoots: [config.workspaceRoot] });
const root = assertPrivateDir(join(d.stateRoot, "evaluations", "v1-step-4b-batch-2"), d.stateRoot);
const ledger = new DollarBudget(join(root, "usage.sqlite"));
try {
  if (ledger.totals().pending) throw new Error("unsettled Claude reservation");
  const stop = ledger.db.query<{ reason: string }, []>("SELECT reason FROM batch_stop").get();
  if (stop && stop.reason !== "owner handover: no new sessions") throw new Error("budget stop remains active");
  const rows = ledger.db
    .query<{ key: string; id: string; report: string }, []>("SELECT key,id,report FROM trials WHERE status='awaiting-judge'")
    .all();
  for (const row of rows) {
    if (!sessionUuid.test(row.id)) throw new Error("invalid held attempt");
    const log = assertPrivateDir(join(root, row.id), d.stateRoot),
      report = JSON.parse(row.report);
    if (report.session !== row.id || report.judgeHeld !== true || existsSync(join(log, "judge.jsonl")))
      throw new Error("reconcile existing judge receipt before retry");
    const frozen = JSON.parse(readFileSync(join(log, "grading-input.json"), "utf8")),
      output = JSON.parse(readFileSync(join(log, "submission.json"), "utf8"));
    if (JSON.stringify(output) !== JSON.stringify(frozen.output)) throw new Error("frozen submission mismatch");
    const judge = await runCodexJudge(
      d,
      mkdtempSync(join(d.accountHome, ".factory-judge-")),
      log,
      frozen.fixtures,
      output,
      frozen.judgeChecks,
    );
    const checks = {
      ...frozen.checks,
      ...judgeGrades(judge.grades, frozen.judgeChecks, new Map(Object.entries(output).map(([p, v]) => [p, Buffer.from(String(v))]))),
    };
    const passed =
      Object.keys(checks).length === Object.keys(frozen.checks).length + frozen.judgeChecks.length && Object.values(checks).every(Boolean);
    ledger.db.run("UPDATE trials SET status=?,report=? WHERE key=? AND id=? AND status='awaiting-judge'", [
      passed ? "passed" : "failed",
      JSON.stringify({ ...report, judgeHeld: false, checks, judge }),
      row.key,
      row.id,
    ]);
  }
  // Clear only the owner's temporary hold. A dollar stop cannot be released here.
  ledger.db.run("DELETE FROM batch_stop WHERE reason=?", ["owner handover: no new sessions"]);
} finally {
  ledger.db.close();
}
