// Reconstruct measured rows and case rates without invoking a model.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { config } from "../factory.config";
import { loadDispatchConfig } from "../src/dispatch/config";
import { parseClaudeStream } from "../src/dispatch/claude";
import { parseCodexEvents } from "../src/dispatch/codex";
import { readJsonl } from "../src/dispatch/jsonl";
import { primary } from "../src/usage/capture";
import { codexMeter, repeatedTeamCharge, sums, type Meter } from "./eval-measurements";
import { flattenCases } from "./batch-one-cases";

const d = loadDispatchConfig({ agentWriteRoots: [config.workspaceRoot] });
const top = join(d.stateRoot, "evaluations"),
  root = join(top, "v1-step-4b-batch-2");
const db = new Database(join(root, "usage.sqlite"), { readonly: true });
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const bad = (checks: Record<string, boolean> = {}) =>
  Object.keys(checks)
    .filter((k) => !checks[k])
    .join(", ");
const afterJudges = new Map<string, { passed: boolean; checks: Record<string, boolean>; judge: string }>();
const judgeDir = new Map<string, string>();
for (const n of readdirSync(root).filter((s) => s.startsWith("judge-"))) {
  const path = join(root, n);
  const f = ["result-v2.json", "result.json"].find((f) => existsSync(join(path, f)));
  if (f) {
    const grade = read(join(path, f));
    afterJudges.set(grade.contestant, grade);
    judgeDir.set(grade.judge, path);
  }
}
const trials = new Map<string, { status: string; report: any }>();
for (const r of db.query<{ key: string; status: string; report: string }, []>("SELECT key,status,report FROM trials").all())
  trials.set(r.key, { status: r.status, report: JSON.parse(r.report ?? "null") });
type Session = { trial: string; role: string; model: string; id: string; meter: Meter; status: string };
const sessions: Session[] = [],
  outcomes = new Map<string, string>();
const team: Array<{ id: string; model: string; meter: Meter }> = [];
const roleOf = (key: string) => key.split(/-\d\d-/)[0]!;
const shorten = (s: string) => s.replace(/\/Users\/[^\s]+/g, "[private path]");
for (const row of db
  .query<{ id: string; trial: string; model: string; kind: string; actual_micro: number; usage: string; outcome: string }, []>(
    "SELECT * FROM sessions ORDER BY rowid",
  )
  .all()) {
  const contestant = trials.get(row.trial),
    local = judgeDir.get(row.id) ?? join(root, row.id);
  if (!row.usage) throw new Error("unsettled Claude usage: " + row.id);
  const parsed = await parseClaudeStream(readJsonl(join(local, row.id + ".stdout.jsonl")));
  if (parsed.sessionId !== row.id || parsed.observedModel !== row.model) throw new Error("unjoined stream: " + row.id);
  const usage =
    parsed.usage ??
    (row.kind === "spec-team" ? await repeatedTeamCharge(readJsonl(join(local, row.id + ".stdout.jsonl")), row.id, row.model) : null);
  const cap = primary(usage, parsed.observedModel, row.outcome),
    meter = sums(cap);
  if (meter.cost === null || Math.ceil(meter.cost * 1_000_000) !== row.actual_micro) throw new Error("unreconciled Claude cost");
  if (cap.lines.length > 1)
    for (const line of cap.lines)
      team.push({
        id: row.id,
        model: line.model!,
        meter: { fresh: line.input, read: line.cacheRead, write: line.cacheWrite, output: line.output, cost: line.costUsd },
      });
  let status: string;
  if (row.kind === "judge") {
    const j = [...afterJudges.values()].find((g) => g.judge === row.id);
    if (!j) throw new Error("missing grade for " + row.id);
    status = j.passed ? "pass" : "fail - " + bad(j.checks);
  } else if (!contestant) throw new Error("unjoined contestant");
  else {
    const r = contestant.report;
    status =
      contestant.status === "awaiting-judge"
        ? "unjudged"
        : r?.session === row.id
          ? contestant.status === "passed"
            ? "pass"
            : "fail - " +
              (bad(r.checks) || shorten(parsed.diagnostics.length ? parsed.diagnostics.join(", ") : (r.error ?? "team handoff")))
          : "team handoff";
    if (r?.session === row.id) outcomes.set(row.trial, status);
  }
  sessions.push({ trial: row.trial, role: row.kind === "judge" ? "Sonnet judge" : row.kind, model: row.model, id: row.id, meter, status });
}
for (const [key, t] of trials) {
  const j = t.report?.judge;
  if (!t.report?.session) continue;
  const path = join(root, t.report.session, "judge.jsonl");
  if (!existsSync(path)) {
    if (j) throw new Error("missing frozen Codex judge receipt");
    continue;
  }
  const parsed = await parseCodexEvents(readJsonl(path));
  if (!parsed.threadId || (j && parsed.threadId !== j.session)) throw new Error("unjoined Codex judge receipt");
  const meter = await codexMeter(d, path, parsed.threadId, "gpt-6.2-astra");
  const failed = j
    ? j.grades.filter((g: any) => !t.report.checks[g.id]).map((g: any) => g.id)
    : [shorten(t.report.error ?? "judge did not supply a grade")];
  sessions.push({
    trial: key,
    role: "Codex judge",
    model: "gpt-6.2-astra",
    id: parsed.threadId,
    meter,
    status: failed.length ? "fail - " + failed.join(", ") : "pass",
  });
}
for (const name of readdirSync(join(root, "codex")).sort()) {
  const dir = join(root, "codex", name);
  if (!existsSync(join(dir, "contestant.json"))) continue;
  const c = read(join(dir, "contestant.json")),
    g = read(join(dir, "grade-v2.json")),
    j = afterJudges.get(c.session);
  const trial = c.key + "#" + c.trial;
  const status =
    g.status === "failed"
      ? "fail - " + (bad(g.deterministic) || shorten(c.error ?? g.error))
      : g.status === "passed" || j?.passed
        ? "pass"
        : j
          ? "fail - " + bad(j.checks)
          : "unjudged";
  outcomes.set(trial, status);
  sessions.push({
    trial,
    role: roleOf(c.key),
    model: c.model,
    id: c.session,
    meter: await codexMeter(d, join(dir, c.id + ".stdout.jsonl"), c.session, c.model),
    status,
  });
}
const table = (xs: unknown[]) =>
  console.log(
    "| " +
      xs
        .map((v) =>
          String(v ?? "unknown")
            .replaceAll("|", "\\|")
            .replace(/\s+/g, " "),
        )
        .join(" | ") +
      " |",
  );
const money = (n: number) => n.toFixed(5);
const metric = (m: Meter) => [m.fresh, m.read, m.write, m.output, money(m.cost!)];
console.log("# Step 4b batch 2 measurements\n");
const claude = sessions.filter((s) => s.model.startsWith("claude")),
  sum = (ss: Session[]) => ss.reduce((n, s) => n + s.meter.cost!, 0);
console.log("The " + claude.length + " Claude sessions consumed $" + money(sum(claude)) + " of the $25 API-equivalent budget.");
console.log(
  "All " + sessions.length + " contestant and grading sessions together cost $" + money(sum(sessions)) + " at API-equivalent rates.",
);
console.log("The batch used low effort for Sonnet judges and high effort for contestants and Codex judges.");
const stop = db.query<{ reason: string }, []>("SELECT reason FROM batch_stop").get();
if (stop) console.log("The persisted stop prevented further Claude launches at `" + stop.reason + "`.");
console.log("\n## Case rates\n");
console.log("Rates count fresh batch 2 contestants and exclude unresolved trials from the graded denominator.");
console.log("The earlier solo lead passed 12/12 on offline rescore and retains its original 11/12 in the batch 1 record.\n");
table(["Case and variant", "Passed / graded", "Fresh trials required", "Pending judgment", "Unstarted", "Reason"]);
table(["---", "---:", "---:", "---:", "---:", "---"]);
for (const role of [
  "spec-lead",
  "spec-reviewer",
  "security-auditor",
  "code-reviewer",
  "database-auditor",
  "architect",
  "infra",
  "frontend",
  "threat-modeler",
  "verifier",
]) {
  for (const row of flattenCases(read(join(import.meta.dir, "../skills", role, "evals/evals.json")).cases)) {
    const key = row.id + (row.variant ? "/" + row.variant : "");
    if (row.variant === "lead-dropped-a-mitigation") continue;
    const n = row.variant === "bug-reproduce-first" ? 2 : 3;
    const actual = [...outcomes].filter(([k]) => k.startsWith(key + "#")).map(([, v]) => v);
    const passed = actual.filter((s) => s === "pass").length,
      graded = actual.filter((s) => s !== "unjudged").length;
    const code = (role === "security-auditor" && !row.variant) || role === "code-reviewer" || role === "database-auditor";
    let why = "";
    if (actual.length < n)
      why = code
        ? "R3"
        : stop
          ? stop.reason.startsWith("owner handover")
            ? "owner handover"
            : "dollar stop"
          : key === "verifier-03-judge-ui-capture" &&
              ![...trials].some(([k, t]) => k.startsWith("verifier-01-plan-by-tag#") && t.status === "passed")
            ? "requires a passing verifier plan"
            : "pending";
    table([key, graded ? passed + "/" + graded : "none", n, actual.length - graded, n - actual.length, why]);
  }
}
console.log("\n## Batch 1 submissions judged in batch 2\n");
const originalRoot = join(top, "v1-step-4b-batch-1", "codex");
const judgedCases = new Set(
  sessions.filter((s) => s.role === "Sonnet judge" && judgeDir.get(s.id)?.includes("/judge-1-")).map((s) => s.trial.split("#")[0]!),
);
const priorRates = new Map<string, boolean[]>();
for (const entry of readdirSync(originalRoot)) {
  const path = join(originalRoot, entry);
  if (!existsSync(join(path, "grade-v2.json"))) continue;
  const c = read(join(path, "contestant.json"));
  if (!judgedCases.has(c.key)) continue;
  const grade = read(join(path, "grade-v2.json")),
    judgment = afterJudges.get(c.session);
  if (grade.status === "unjudged" && !judgment) throw new Error("unresolved original case: " + c.key);
  const rates = priorRates.get(c.key) ?? [];
  rates.push(grade.status === "passed" || (grade.status === "unjudged" && judgment?.passed === true));
  priorRates.set(c.key, rates);
}
console.log("The combined rates include batch 1 deterministic failures and the frozen submissions judged in this batch.\n");
table(["Case and variant", "Combined pass rate"]);
table(["---", "---:"]);
for (const [key, rows] of priorRates) table([key, rows.filter(Boolean).length + "/" + rows.length]);
console.log("");
table(["Case", "Trial", "Contestant session", "Result"]);
table(["---", "---:", "---", "---"]);
for (const s of sessions.filter((s) => s.role === "Sonnet judge" && judgeDir.get(s.id)?.includes("/judge-1-"))) {
  const [key, trial] = s.trial.split("#");
  table([key, trial, [...afterJudges].find(([, r]) => r.judge === s.id)![0], s.status]);
}
console.log("\n## Sessions\n");
table(["Case and variant", "Trial", "Role", "Model", "Session", "Fresh", "Cache read", "Cache write", "Output", "USD", "Result"]);
table(["---", "---:", "---", "---", "---", "---:", "---:", "---:", "---:", "---:", "---"]);
for (const s of sessions) table([...s.trial.split("#"), s.role, s.model, s.id, ...metric(s.meter), s.status]);
if (team.length) {
  console.log("\n## Team usage by model\n");
  console.log("These native per-model figures are already included in the parent session totals.\n");
  table(["Session", "Model", "Fresh", "Cache read", "Cache write", "Output", "USD"]);
  table(["---", "---", "---:", "---:", "---:", "---:", "---:"]);
  for (const r of team) table([r.id, r.model, ...metric(r.meter)]);
}
console.log("\n## Cost by case type\n");
table(["Role", "Sessions", "Total USD", "Mean USD"]);
table(["---", "---:", "---:", "---:"]);
for (const role of new Set(sessions.map((s) => s.role))) {
  const group = sessions.filter((s) => s.role === role),
    n = sum(group);
  table([role, group.length, money(n), money(n / group.length)]);
}
console.log("\n## Cost by case and variant\n");
table(["Case and variant", "Contestant USD", "Judge USD", "Total USD"]);
table(["---", "---:", "---:", "---:"]);
for (const key of new Set(sessions.map((s) => s.trial.split("#")[0]))) {
  const group = sessions.filter((s) => s.trial.split("#")[0] === key);
  const judges = group.filter((s) => s.role.endsWith("judge"));
  table([key, money(sum(group) - sum(judges)), money(sum(judges)), money(sum(group))]);
}
db.close();
