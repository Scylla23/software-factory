// Report the batch from native usage streams and private receipts without launching either harness.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { config } from "../factory.config";
import { loadDispatchConfig } from "../src/dispatch/config";
import { parseClaudeStream } from "../src/dispatch/claude";
import { parseCodexEvents } from "../src/dispatch/codex";
import { readJsonl } from "../src/dispatch/jsonl";
import { primary } from "../src/usage/capture";
import { codexMeter, sums, type Meter } from "./eval-measurements";
import { flattenCases } from "./batch-one-cases";
import { revisionFixtureError } from "./eval-inputs";

const dispatch = loadDispatchConfig({ agentWriteRoots: [config.workspaceRoot] });
const batch = join(dispatch.stateRoot, "evaluations", "v1-step-4b-batch-1"),
  db = new Database(join(batch, "usage.sqlite"), { readonly: true });
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
type Session = { key: string; trial: number; role: string; model: string; session: string; meter: Meter; result: string };
const sessions: Session[] = [];
const outcomes = new Map<string, string[]>();
const cost = new Map<string, { n: number; usd: number }>();
function add(line: Session) {
  sessions.push(line);
  if (line.role !== "judge") {
    const list = outcomes.get(line.key) ?? [];
    list[line.trial - 1] = line.result;
    outcomes.set(line.key, list);
  }
  const group = line.role + "/" + line.model,
    current = cost.get(group) ?? { n: 0, usd: 0 };
  if (line.meter.cost === null) throw new Error("missing case cost");
  current.n++;
  current.usd += line.meter.cost;
  cost.set(group, current);
}
const bad = (checks: Record<string, boolean> = {}) =>
  Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k)
    .join(", ");
const ledger = db
  .query<{ id: string; trial: string; model: string; actual_input: number; actual_output: number }, []>(
    "SELECT * FROM sessions ORDER BY rowid",
  )
  .all();
for (const row of ledger) {
  const trial = db.query<{ status: string; report: string }, [string]>("SELECT status,report FROM trials WHERE key=?").get(row.trial);
  if (!trial) throw new Error("unjoined trial");
  const detail = JSON.parse(trial.report);
  const [key, t] = row.trial.split("#");
  const local = join(batch, row.id);
  const parsed = await parseClaudeStream(readJsonl(join(local, row.id + ".stdout.jsonl")));
  if (parsed.sessionId !== row.id || parsed.observedModel !== row.model || !parsed.usage) throw new Error("unjoined Claude stream");
  const m = sums(primary(parsed.usage, parsed.observedModel, "completed"));
  if (m.fresh + m.read + (m.write ?? 0) !== row.actual_input || m.output !== row.actual_output)
    throw new Error("Claude native and reserved actuals disagree");
  add({
    key: key!,
    trial: Number(t),
    session: row.id,
    role: key!.startsWith("triage") ? "triage" : "spec-lead",
    model: row.model,
    meter: m,
    result: trial.status === "passed" ? "pass" : "fail - " + (bad(detail.checks) || detail.error || "handoff"),
  });
  if (detail.judge) {
    const session = detail.judge.session;
    const logs = [
      join(local, "judge.jsonl"),
      ...readdirSync(local)
        .filter((v) => v.startsWith("judge-"))
        .map((v) => join(local, v, "judge.jsonl")),
    ];
    let path;
    for (const log of logs.filter(existsSync)) if ((await parseCodexEvents(readJsonl(log))).threadId === session) path = log;
    if (!path) throw new Error("missing corresponding Codex judge");
    const rejected = detail.judge.grades.filter((r: { id: string }) => !detail.checks[r.id]).map((r: { id: string }) => r.id);
    add({
      key: key!,
      trial: Number(t),
      session,
      role: "judge",
      model: "gpt-6.2-astra",
      meter: await codexMeter(dispatch, path, session, "gpt-6.2-astra"),
      result: rejected.length ? "no - " + rejected.join(", ") : "yes",
    });
  }
}
for (const name of readdirSync(join(batch, "codex")).sort()) {
  const root = join(batch, "codex", name),
    contest = join(root, "contestant.json");
  if (!existsSync(contest)) continue;
  const setup = json(join(root, "start.json")),
    r = json(contest);
  const g = existsSync(join(root, "grade-v2.json")) ? json(join(root, "grade-v2.json")) : null;
  const invalid = revisionFixtureError(r.key, setup.task, setup.brief.specSet?.sha256);
  const status = invalid
    ? "invalid fixture - " + invalid + " (recorded check: " + bad(g?.deterministic) + ")"
    : r.error
    ? "fail - " + r.error
    : g?.status === "failed"
      ? "fail - " + (bad(g.deterministic) || bad(g.judgments))
      : g?.status === "passed"
        ? "pass"
        : "unjudged";
  add({
    key: r.key,
    trial: r.trial,
    session: r.session,
    role: setup.role,
    model: r.model,
    result: status,
    meter: await codexMeter(dispatch, join(root, r.id + ".stdout.jsonl"), r.session, r.model),
  });
}
db.close();
const cell = (v: unknown) =>
  String(v ?? "unknown")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
const table = (items: unknown[]) => console.log("| " + items.map(cell).join(" | ") + " |");
console.log("# Step 4b batch 1 measurements\n");
console.log("The Claude contestant stop rule counted fresh input, cache reads and cache writes across all measured models.");
console.log("Codex counts below join each native public turn total to its protected per-request token records.");
console.log("USD amounts are API-equivalent costs from the merged step 8 capture and price snapshot.\n");
const claude = sessions.filter((s) => s.role === "triage" || s.role === "spec-lead");
const countedInput = claude.reduce((n, s) => n + s.meter.fresh + s.meter.read + (s.meter.write ?? 0), 0);
const countedOutput = claude.reduce((n, s) => n + s.meter.output, 0);
console.log("Claude consumed " + countedInput.toLocaleString("en-US") + " input and " + countedOutput.toLocaleString("en-US") + " output tokens.");
console.log("The next solo lead estimate of 196,796 input exceeded the remaining 33,296 input tokens.");
console.log("The stop left eleven spec-lead trials unstarted and eleven deterministically passing Codex submissions awaiting a Sonnet judge.");
console.log("Triage used low effort and the spec lead, Codex contestants and Codex judges used high effort.\n");
console.log("## Trials and case rates\n");
table(["Case or variant", "Pass / graded", "Pass / required", "Failed", "Invalid fixture", "Unjudged", "Unstarted", "Reason for unstarted trials"]);
table(["---", "---:", "---:", "---:", "---:", "---:", "---:", "---"]);
for (const role of ["triage", "spec-lead", "builder", "spec-reviewer", "security-auditor"] as const) {
  const rows = flattenCases(json(join(import.meta.dir, "../skills", role, "evals/evals.json")).cases);
  for (const row of rows) {
    const key = row.id + (row.variant ? "/" + row.variant : ""),
      obs = outcomes.get(key) ?? [];
    const h = role === "triage" || role === "spec-lead" ? "claude" : "codex";
    // The batch-one refusals are historical observations on the original pin.
    const missing = role === "spec-reviewer" ? ["native file tool write-root matrix for spec-reviewer"]
      : role === "security-auditor" && !row.id.includes("spec-stage") ? ["R3 project-command substitution"] : [];
    const total = obs.filter(Boolean).length,
      pass = obs.filter((v) => v === "pass").length,
      failed = obs.filter((v) => v.startsWith("fail")).length,
      invalid = obs.filter((v) => v.startsWith("invalid fixture")).length;
    table([
      key,
      pass + failed ? pass + "/" + (pass + failed) : "none",
      pass + "/3",
      failed,
      invalid,
      total - invalid - failed - pass,
      3 - total,
      total === 3 ? "" : missing.join(", ") || (h === "claude" ? "Claude stop rule" : "pending"),
    ]);
  }
}
console.log("\nThe triage schema rejected the tier signal in trial 3 of the single-area bug case.");
console.log("The solo lead named six existing files, but its reused-files explanation also named the HTTP route `/tasks`, which the literal path check rejected.");
console.log("The revision fixture staged its previous verdict with the current digest, making its identity check impossible in all three trials.");
console.log("Invalid fixtures and unjudged trials are excluded from the graded denominator.");
console.log("\n## Session measurements\n");
table([
  "Case or variant",
  "Trial",
  "Function",
  "Model",
  "Session",
  "Fresh input",
  "Cache read",
  "Cache write",
  "Output",
  "USD",
  "Result or failing check",
]);
table(["---", "---:", "---", "---", "---", "---:", "---:", "---:", "---:", "---:", "---"]);
for (const s of sessions)
  table([
    s.key,
    s.trial,
    s.role,
    s.model,
    s.session,
    s.meter.fresh,
    s.meter.read,
    s.meter.write,
    s.meter.output,
    s.meter.cost!.toFixed(5),
    s.result,
  ]);
console.log("\n## Cost by case type\n");
table(["Function and model", "Sessions", "Total USD", "Mean USD per session"]);
table(["---", "---:", "---:", "---:"]);
for (const [key, row] of cost) table([key, row.n, row.usd.toFixed(5), (row.usd / row.n).toFixed(5)]);
console.log("\nThe " + sessions.length + " measured sessions totaled $" + sessions.reduce((n, s) => n + s.meter.cost!, 0).toFixed(5) + " at API-equivalent rates.");
console.log("The only measured spec-lead trial was solo, so its cost does not estimate a team session.");
console.log("\n## Cost by case and variant\n");
table(["Case or variant", "Contestant USD", "Judge USD", "Measured total USD"]);
table(["---", "---:", "---:", "---:"]);
for (const key of outcomes.keys()) {
  const sum = (judge: boolean) =>
    sessions.filter((s) => s.key === key && (s.role === "judge") === judge).reduce((n, s) => n + s.meter.cost!, 0);
  const c = sum(false),
    j = sum(true);
  table([key, c.toFixed(5), j.toFixed(5), (c + j).toFixed(5)]);
}
