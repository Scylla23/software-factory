import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { config } from "../factory.config";
import { loadDispatchConfig, runAgent } from "../src/dispatch";
import { checkoutSnapshot, createAttempt } from "../src/dispatch/attempt";
import { brokerCommands } from "../src/dispatch/broker";
import type { BriefInput } from "../src/dispatch/brief";
import { bundleDigest } from "../src/dispatch/bundle";
import { claudeWrites } from "../src/dispatch/claude-writes";
import { assertPrivateDir } from "../src/dispatch/config";
import { runGit } from "../src/dispatch/git";
import { PROJECT_INSTRUCTION_PATHS } from "../src/dispatch/instructions";
import { collectOutputs } from "../src/dispatch/output";
import { requireSkillProofs } from "../src/dispatch/skill-launch";
import { flattenCases, judgeGrades } from "./batch-one-cases";
import { evalCheckout, pinnedFixture } from "./eval-checkout";
import { runCodexJudge } from "./eval-codex-judge";
import { DollarBudget } from "./eval-dollar-budget";
import { caseInput, inspectBlindStream, stageBlindInputs } from "./eval-inputs";
import { observedBrokerTest, reviewChecks } from "./eval-review-checks";

const role = process.argv[2];
if (process.argv.length > 4 || (role !== "code-reviewer" && role !== "database-auditor")) throw new Error("expected a review role");
const selected = process.argv[3];
const dispatch = loadDispatchConfig({ agentWriteRoots: [config.workspaceRoot] });
const git = dispatch.executables.git;
const root = assertPrivateDir(join(dispatch.stateRoot, "evaluations", "v1-step-4b-batch-2"), dispatch.stateRoot);
const factory = realpathSync(join(import.meta.dir, ".."));
const pin = runGit(git, factory, ["log", "-1", "--format=%H", "HEAD", "--", "skills"]).toString().trim();
const model = config.agents.reviewer.model;
const ledger = new DollarBudget(join(root, "usage.sqlite"));
const cases = flattenCases(JSON.parse(pinnedFixture(git, factory, pin, "skills/" + role + "/evals/evals.json").toString()).cases);
const make = (dir: string) => { mkdirSync(dir, { mode: 0o700 }); return dir; };
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
try {
  requireSkillProofs("claude", role, [], "code", dispatch);
  for (const row of cases) {
    const caseKey = row.id + (row.variant ? "/" + row.variant : "");
    if (selected && selected !== caseKey) continue;
    const first = ledger.db.query<{ status: string }, [string]>("SELECT status FROM trials WHERE key=?").get(caseKey + "#1");
    if (first?.status === "started") throw new Error("reconcile " + caseKey + "#1");
    if (first && first.status !== "failed") continue;
    const key = caseKey + (first ? "#2" : "#1");
    const second = first && ledger.db.query<{ status: string }, [string]>("SELECT status FROM trials WHERE key=?").get(key);
    if (second?.status === "started") throw new Error("reconcile " + key);
    if (second) continue;
    const id = crypto.randomUUID();
    const log = make(join(root, id));
    const local = mkdtempSync(join(dispatch.accountHome, ".factory-trial-"));
    const repo = make(join(local, "source"));
    const input = caseInput(git, factory, pin, role, row.id, row.variant);
    const refs = evalCheckout(git, factory, pin, repo, log, input.patch);
    const dirs = createAttempt({
      runRoot: join(local, "runs"), stateRoot: dispatch.stateRoot, accountHome: dispatch.accountHome,
      project: repo, attemptId: id, role, stage: "code",
    });
    for (const cwd of [dirs.worktree, dirs.scratchRepo!]) checkoutSnapshot(git, repo, refs.head, cwd);
    const staged = stageBlindInputs(git, factory, pin, role, input, dirs.taskDir, refs) as unknown as
      Omit<BriefInput, "project"> & { project: Partial<BriefInput["project"]> };
    const { test, diff, show } = brokerCommands();
    const brief: BriefInput = {
      ...staged,
      project: {
        name: "project", stack: "bun", isNew: false, fixtures: [], migrationGlobs: [], securityGlobs: [], ...staged.project,
        commands: { test: test!, diff: diff!, show: show! },
      },
      routing: {
        S: { builder: "Sol 6.2", codeReviewer: "Opus 5.5" },
        M: { builder: "Sonnet 5.5", codeReviewer: "Sol 6.2" },
        L: { builder: "Opus 5.5", codeReviewer: "GPT-6.2-Astra" },
      },
    };
    const inputHash = bundleDigest(dirs.taskDir);
    const source = make(join(log, "factory"));
    checkoutSnapshot(git, factory, pin, source);
    const canary = crypto.randomUUID();
    writeFileSync(join(source, "skills/_shared/evals", canary + ".txt"), canary, { flag: "wx", mode: 0o400 });
    const limits = ledger.reserve(id, key, caseKey, role, model, { id, revision: pin });
    const result = await runAgent({
      ...config.agents.reviewer, runId: id, prompt: "", worktreePath: dirs.worktree, logDir: log, evaluationLimits: limits,
      instructions: { repo, baseSha: refs.base, paths: PROJECT_INSTRUCTION_PATHS },
      skill: { dirs, brief, members: [], factoryRepo: source, factoryCommit: pin, toolDirs: config.pilot.toolDirs },
    }, dispatch);
    const actual = ledger.settle(id, result.usage?.harness === "claude" ? result.usage : null, result.outcome);
    let report: object;
    let passed = false;
    try {
      if (result.outcome !== "completed" || result.sessionId !== id || result.observedModel !== model || !result.bundleHash ||
          result.diagnostics.length || result.quarantineWorktree || !result.noKnownSurvivors)
        throw new Error("incomplete or quarantined reviewer");
      await inspectBlindStream(result.stdoutPath, canary, dirs.worktree);
      if (bundleDigest(dirs.taskDir) !== inputHash) throw new Error("staged inputs changed");
      const author = { role, sessionId: id };
      const identity = { ...author, taskId: brief.taskId, attemptId: id };
      const name = "verdicts/" + role + ".json";
      const writes = await claudeWrites(identity, dispatch.stateRoot, dispatch.harnessHomes.claude, dirs.outDir);
      const files = collectOutputs(dirs, identity, new Map([[name, author]]), writes);
      const verdict = JSON.parse(files.get(name)!.toString());
      const schema = JSON.parse(await Bun.file(join(dirs.skillsDir, "_shared/verdict.schema.json")).text());
      const valid = Boolean(new Ajv2020({ strictTypes: false, allowUnionTypes: true }).compile(schema)(verdict));
      const clean = runGit(git, dirs.worktree, ["rev-parse", "HEAD"]).toString().trim() === refs.head &&
        !runGit(git, dirs.worktree, ["status", "--porcelain"]).length;
      const scores: Record<string, boolean> = valid
        ? reviewChecks(caseKey, verdict, { role, taskId: brief.taskId, round: brief.round, baseSha: refs.base,
          headSha: refs.head, specSetSha256: brief.specSet!.sha256 }, clean, await observedBrokerTest(result.stdoutPath))
        : { schema: false };
      const checks = Object.fromEntries(row.checks.filter(c => c.kind === "deterministic").map(c => [c.id, scores[c.id] === true]));
      const fixtures = {
        task: Object.fromEntries(await Promise.all(Object.keys(input.files).map(async p => [p, await Bun.file(join(dirs.taskDir, p)).text()]))),
        diff: runGit(git, repo, ["diff", "--no-ext-diff", refs.base, refs.head]).toString(),
        source: Object.fromEntries(runGit(git, repo, ["ls-tree", "-rz", "--name-only", refs.head]).toString().split("\0")
          .filter(Boolean).map(p => [p, runGit(git, repo, ["show", refs.head + ":" + p]).toString()])),
      };
      const output = Object.fromEntries([...files].map(([p, bytes]) => [p, bytes.toString()]));
      const judgeChecks = row.checks.filter(c => c.kind === "judge");
      save(join(log, "submission.json"), output);
      save(join(log, "grading-input.json"), { fixtures, output, checks, judgeChecks });
      const judge = valid && judgeChecks.length && await runCodexJudge(dispatch, make(join(local, "judge")), log, fixtures, output, judgeChecks);
      const graded = { ...checks, ...judgeGrades(judge ? judge.grades : undefined, judgeChecks, files) };
      passed = Object.keys(graded).length === row.checks.length && Object.values(graded).every(Boolean);
      report = { session: id, actual, checks: graded, judge: judge || undefined };
    } catch (error) {
      report = { session: id, actual, error: (error as Error).message };
    }
    ledger.db.run("UPDATE trials SET status=?,report=? WHERE key=?", [passed ? "passed" : "failed", JSON.stringify(report), key]);
    console.log(JSON.stringify({ key, passed, ...report }));
    if (actual.overshootUsd) break;
  }
} finally {
  ledger.db.close();
}
