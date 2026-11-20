import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config } from "../factory.config";
import { assertPrivateDir, loadDispatchConfig } from "../src/dispatch/config";
import { judgeGrades, parseJudgeGrades } from "./batch-one-cases";
import { parseClaudeStream } from "../src/dispatch/claude";
import { readJsonl } from "../src/dispatch/jsonl";
import { DollarBudget } from "./eval-dollar-budget";
import { judge } from "./grade-codex-trials";

const dispatch = loadDispatchConfig({ agentWriteRoots: [config.workspaceRoot] });
const evals = join(dispatch.stateRoot, "evaluations"),
  root = join(evals, "v1-step-4b-batch-2");
mkdirSync(root, { recursive: true, mode: 0o700 });
assertPrivateDir(root, dispatch.stateRoot);
const ledger = new DollarBudget(join(root, "usage.sqlite"));
const load = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
try {
  const origin = process.argv[2];
  if (origin !== "1" && origin !== "2") throw new Error("choose the batch containing the frozen submissions");
  const trial = Number(process.argv[3] ?? "1");
  if (process.argv.length > 4 || (trial !== 1 && trial !== 2)) throw new Error("choose trial 1 or 2");
  const contestants = join(evals, "v1-step-4b-batch-" + origin, "codex");
  for (const entry of readdirSync(contestants).sort()) {
    const source = join(contestants, entry);
    if (!existsSync(join(source, "grade-v2.json"))) continue;
    assertPrivateDir(source, dispatch.stateRoot);
    const grade = load(source, "grade-v2.json");
    if (grade.trial !== trial || grade.status !== "unjudged" || !Object.values(grade.deterministic).every((v) => v === true)) continue;
    if (trial === 2) {
      const first = entry.replace(/-2(?=-[a-f0-9]{12}$|$)/, "-1");
      const result = ["result-v2.json", "result.json"].map(name => join(root, "judge-" + origin + "-" + first, name)).find(existsSync);
      const firstGrade = join(contestants, first, "grade-v2.json");
      if (result ? load(dirname(result), basename(result)).passed !== false
        : !existsSync(firstGrade) || load(dirname(firstGrade), "grade-v2.json").status !== "failed") continue;
    }
    const destination = join(root, "judge-" + origin + "-" + entry);
    if (existsSync(join(destination, "result-v2.json"))) continue;
    const setup = load(source, "start.json"),
      contestant = load(source, "contestant.json"),
      packet = load(source, "judge-input.json");
    if (setup.id !== contestant.id || contestant.error || !contestant.session || setup.key !== grade.key || setup.trial !== grade.trial)
      throw new Error("unjoined judge packet");
    if (existsSync(join(destination, "result.json"))) {
      const original = load(destination, "result.json");
      if (original.contestant !== contestant.session) throw new Error("unjoined original grade");
      const parsed = await parseClaudeStream(readJsonl(join(destination, original.judge + ".stdout.jsonl")));
      if (parsed.sessionId !== original.judge || !parsed.succeeded || parsed.observedModel !== "claude-sonnet-5-5")
        throw new Error("invalid saved judge evidence");
      const checks = judgeGrades(
        parseJudgeGrades(parsed.resultText ?? ""),
        packet.checks,
        new Map(Object.entries(packet.candidate).map(([k, v]) => [k, Buffer.from(String(v))])),
      );
      const paid = {
        ...original,
        checks,
        passed: packet.checks.length === Object.keys(checks).length && Object.values(checks).every(Boolean),
      };
      writeFileSync(join(destination, "result-v2.json"), JSON.stringify(paid), { flag: "wx", mode: 0o600 });
      continue;
    }
    if (existsSync(destination)) throw new Error("incomplete prior judge, reconcile before retry: " + entry);
    mkdirSync(destination, { mode: 0o700 });
    const decision = await judge(ledger, setup, destination, packet.checks, packet.candidate, packet.fixtures);
    if (decision.status === "stopped") {
      rmdirSync(destination);
      break;
    }
    const checks = judgeGrades(
      decision.grades,
      packet.checks,
      new Map(Object.entries(packet.candidate).map(([key, value]) => [key, Buffer.from(String(value))])),
    );
    const passed = Object.keys(checks).length === packet.checks.length && Object.values(checks).every(Boolean);
    const score = {
      key: setup.key,
      trial: setup.trial,
      contestant: contestant.session,
      judge: decision.id,
      passed,
      checks,
      actual: decision.actual,
    };
    writeFileSync(join(destination, "result.json"), JSON.stringify(score), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(score));
  }
} finally {
  ledger.db.close();
}
