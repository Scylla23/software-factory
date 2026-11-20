// Regrade one already authenticated Claude submission with Codex. Never repeat its contestant.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { config } from "../factory.config";
import { loadDispatchConfig } from "../src/dispatch/config";
import { claudeChildStarts } from "../src/dispatch/claude-writes";
import { runGit } from "../src/dispatch/git";
import { isRecord, readJsonl } from "../src/dispatch/jsonl";
import { deterministicBatchOne, flattenCases, judgeGrades } from "./batch-one-cases";
import { JudgeQuarantined, runCodexJudge } from "./eval-codex-judge";
import { stageBlindInputs, caseInput } from "./eval-inputs";
import { plantPilot } from "./eval-pilot";
import type { runBrief } from "../src/dispatch/brief";

const dispatch = loadDispatchConfig({ agentWriteRoots: [config.workspaceRoot] });
const batch = join(dispatch.stateRoot, "evaluations", "v1-step-4b-batch-1");
const id = process.argv[2] ?? "";
if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new Error("select a recorded session UUID");
const dir = join(batch, id);
const db = new Database(join(batch, "usage.sqlite"));
const trial = db
  .query<{ key: string; revision: string; report: string }, [string]>("SELECT key,revision,report FROM trials WHERE id=?")
  .get(id);
if (!trial) throw new Error("session is not a contestant");
const original = JSON.parse(trial.report);
if (!original.error || original.judge) throw new Error("only an interrupted judge can be retried");
const source = join(dir, "factory");
const output: Record<string, string> = JSON.parse(readFileSync(join(dir, "submission.json"), "utf8"));
const files = new Map(Object.entries(output).map(([k, s]) => [k, Buffer.from(s)]));
const root = mkdtempSync(join(dispatch.accountHome, ".factory-eval-regrade-"));
const make = (p: string) => {
  const path = join(root, p);
  mkdirSync(path, { mode: 0o700 });
  return path;
};
const git = dispatch.executables.git;
let quarantine = false;
try {
  let packet;
  const checkpoint = join(dir, "grading-input.json");
  if (existsSync(checkpoint)) packet = JSON.parse(readFileSync(checkpoint, "utf8"));
  else {
    // This one pre-merge case predates saved grading packets. Prove the exact Git commit before re-staging any fixtures.
    if (!trial.key.startsWith("spec-lead-01-draft-and-revise/bug-reproduce-first#"))
      throw new Error("no saved grading input for this case");
    const privateLog = [...new Bun.Glob("projects/*/" + id + ".jsonl").scanSync(dispatch.harnessHomes.claude)];
    if (privateLog.length !== 1) throw new Error("ambiguous source run");
    let brief: ReturnType<typeof runBrief> | undefined;
    for await (const line of readJsonl(join(dispatch.harnessHomes.claude, privateLog[0]!))) {
      if (line.kind !== "record") throw new Error("invalid source run");
      const e = line.value;
      if (e.type === "user" && e.sessionId === id && isRecord(e.message) && typeof e.message.content === "string") {
        const match = /^<factory_run>\n(.*)\n<\/factory_run>$/.exec(e.message.content);
        if (match) {
          if (brief) throw new Error("duplicate run brief");
          brief = JSON.parse(match[1]!);
        }
      }
    }
    if (!brief || brief.attemptId !== id || brief.teamEnabled !== false) throw new Error("missing original solo run brief");
    const repo = make("source");
    const { base } = plantPilot(git, source, trial.revision, repo);
    const body = runGit(git, repo, ["cat-file", "commit", base]).toString();
    // Git commits bind their tree, parent, message, timestamps, author and committer.
    const start = Math.floor(statSync(dir).birthtimeMs / 1000);
    let matched = false;
    for (let t = start - 120; t <= start + 120; t++) {
      const candidate = Buffer.from(body.replace(/(^author .+> |^committer .+> )\d+(?= [+-]\d{4}$)/gm, (_m, prefix) => prefix + t));
      if (
        createHash("sha1")
          .update("commit " + candidate.length + "\0")
          .update(candidate)
          .digest("hex") === brief.baseSha
      ) {
        matched = true;
        break;
      }
    }
    if (!matched) throw new Error("could not restore the exact blind trial source");
    const catalog = JSON.parse(readFileSync(join(source, "skills/spec-lead/evals/evals.json"), "utf8"));
    const row = flattenCases(catalog.cases).find((r) => r.id + "/" + r.variant === trial.key.split("#")[0])!;
    const input = caseInput(git, source, trial.revision, "spec-lead", row.id, row.variant);
    const taskDir = make("task");
    stageBlindInputs(git, source, trial.revision, "spec-lead", input, taskDir, { base: brief.baseSha, head: brief.baseSha });
    const tracked = new Set(runGit(git, repo, ["ls-tree", "-r", "-z", "--name-only", base]).toString().split("\0").filter(Boolean));
    const children = await claudeChildStarts(dispatch.stateRoot, dispatch.harnessHomes.claude, id);
    const checks = deterministicBatchOne({
      ...row,
      brief: { ...brief, taskDir },
      files,
      clean: false,
      inspected: false,
      children: children.size,
      tracked,
      skills: join(source, "skills"),
    });
    const fixtures = {
      task: Object.fromEntries(Object.keys(input.files).map((p) => [p, readFileSync(join(taskDir, p), "utf8")])),
      source: Object.fromEntries(
        [...tracked]
          .filter((p) => !p.startsWith(".") && !p.endsWith(".lock"))
          .map((p) => [p, runGit(git, repo, ["show", base + ":" + p]).toString()]),
      ),
    };
    packet = { fixtures, output, checks, judgeChecks: row.checks.filter((c) => c.kind === "judge") };
    writeFileSync(checkpoint, JSON.stringify(packet), { flag: "wx", mode: 0o600 });
  }
  const judgeDir = join(dir, "judge-" + crypto.randomUUID());
  mkdirSync(judgeDir, { mode: 0o700 });
  const judge = await runCodexJudge(dispatch, make("judge"), judgeDir, packet.fixtures, output, packet.judgeChecks);
  const checks = { ...packet.checks, ...judgeGrades(judge.grades, packet.judgeChecks, files) };
  const passed = Object.values(checks).every((v) => v === true);
  const report = { ...original, error: undefined, priorJudgeError: original.error, judge, checks, session: id };
  const status = passed ? "passed" : "failed";
  const updated = db.run("UPDATE trials SET status=?,report=? WHERE id=? AND report=?", [status, JSON.stringify(report), id, trial.report]);
  if (updated.changes !== 1) throw new Error("trial grading changed concurrently");
  console.log(JSON.stringify({ id, status, checks, judge: judge.session }));
} catch (error) {
  quarantine = error instanceof JudgeQuarantined;
  throw error;
} finally {
  db.close();
  if (!quarantine) rmSync(root, { recursive: true, force: true });
}
