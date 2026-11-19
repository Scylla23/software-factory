import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../factory.config";
import { checkoutSnapshot, createAttempt } from "../src/dispatch/attempt";
import { requiredMembers, runBrief, type BriefInput } from "../src/dispatch/brief";
import { bundleDigest } from "../src/dispatch/bundle";
import { claudeChildStarts, claudeWrites } from "../src/dispatch/claude-writes";
import { assertPrivateDir, loadDispatchConfig } from "../src/dispatch/config";
import { runGit } from "../src/dispatch/git";
import { runAgent } from "../src/dispatch";
import { PROJECT_INSTRUCTION_PATHS } from "../src/dispatch/instructions";
import { isRecord, readJsonl } from "../src/dispatch/jsonl";
import { authenticateTeam } from "../src/dispatch/team-outputs";
import { collectOutputs, type OutputAuthor } from "../src/dispatch/output";
import { requiredProofs } from "../src/dispatch/skill-launch";
import { flattenCases, deterministicBatchOne, exposesAnswer, judgeGrades } from "./batch-one-cases";
import { EvalBudget } from "./eval-budget";
import { caseInput, stageBlindInputs } from "./eval-inputs";
import { evalCheckout, pinnedFixture } from "./eval-checkout";
import { plantPilot } from "./eval-pilot";
import { runHomeProofs } from "./run-home-proofs";
import { runCodexJudge } from "./eval-codex-judge";

const dispatch = loadDispatchConfig({ agentWriteRoots: [config.workspaceRoot] });
const git = dispatch.executables.git,
  factory = realpathSync(join(import.meta.dir, ".."));
const pin = runGit(git, factory, ["rev-parse", "HEAD"]).toString().trim();
const dry = process.argv[2] === "--preflight";
if (process.argv.slice(2).some((a) => a !== "--preflight")) throw new Error("only --preflight is accepted");
const batch = join(dispatch.stateRoot, "evaluations", "v1-step-4b-batch-1");
mkdirSync(batch, { recursive: true, mode: 0o700 });
assertPrivateDir(batch, dispatch.stateRoot);
const ledger = new EvalBudget(join(batch, "usage.sqlite"));
const mkdir = (root: string, name: string) => {
  const p = join(root, name);
  mkdirSync(p, { mode: 0o700 });
  return p;
};
const routing = {
  S: { builder: "Sol 6.2", codeReviewer: "Opus 5.5" },
  M: { builder: "Sonnet 5.5", codeReviewer: "Sol 6.2" },
  L: { builder: "Opus 5.5", codeReviewer: "GPT-6.2-Astra" },
};

async function inspectBlindStream(stdoutPath: string, canary: string, worktree: string) {
  let inspected = false;
  for await (const item of readJsonl(stdoutPath)) {
    if (item.kind !== "record" || JSON.stringify(item.value).includes(canary)) throw new Error("compromised blind trial");
    const e = item.value;
    if (e.type !== "assistant" || !isRecord(e.message) || !Array.isArray(e.message.content)) continue;
    for (const c of e.message.content)
      if (isRecord(c) && c.type === "tool_use" && isRecord(c.input)) {
        if (/(?:^|[\s/"'])evals\//.test(JSON.stringify(c.input)) && ["Bash", "Read", "Glob", "Grep", "Agent"].includes(String(c.name)))
          throw new Error("eval fixture access");
        const target = c.input.file_path ?? c.input.path ?? (c.name === "Glob" || c.name === "Grep" ? "." : null);
        const path = typeof target === "string" ? resolve(worktree, target) : undefined;
        if (
          typeof path === "string" &&
          (path === worktree || path.startsWith(worktree + "/")) &&
          ["Read", "Glob", "Grep"].includes(String(c.name))
        )
          inspected = true;
      }
  }
  return inspected;
}

async function batchOne() {
  if (!dry) for (const h of ["claude", "codex"] as const) {
    const home=runHomeProofs(h,dispatch);
    console.log(JSON.stringify(home));
    if(h==="claude" && !home.failures?.includes("claude proof credential not provisioned")) console.log(JSON.stringify(runHomeProofs("claude",dispatch,true)));
  }

  let skipped = 0;
  for (const role of ["triage", "spec-lead"] as const) {
    const cases = JSON.parse(pinnedFixture(git, factory, pin, `skills/${role}/evals/evals.json`).toString()).cases;
    for (const row of flattenCases(cases)) {
      const input = caseInput(git, factory, pin, role, row.id, row.variant);
      const teamCase = role === "spec-lead" && /spec-lead-0[23]-/.test(row.id);
      const members = teamCase ? requiredMembers("L", true, false) : [];
      const missing = requiredProofs("claude", role, members, role === "triage" ? "triage" : "spec", dispatch);
      const promotion = row.id === "spec-lead-02-tier-promotion-runs-team";
      if (exposesAnswer(input.files)) missing.push("case discloses its planted classification in contestant input");
      const key = row.id + (row.variant ? "/" + row.variant : "");
      if (missing.length || dry) {
        console.log(JSON.stringify({ case: key, eligible: !missing.length, missing, trials: 3 }));
        if (missing.length) skipped += 3;
        continue;
      }
      for (let trial = 1; trial <= 3; trial++) {
        const trialKey = key + "#" + trial;
        const previous = ledger.db
          .query<{ revision: string; status: string }, [string]>("SELECT revision,status FROM trials WHERE key=?")
          .get(trialKey);
        if (previous) {
          if (previous.revision !== pin || previous.status === "started")
            throw new Error("previous trial requires reconciliation: " + trialKey);
          console.log(JSON.stringify({ trial: trialKey, reused: previous.status }));
          continue;
        }
        const id = crypto.randomUUID(),
          root = mkdtempSync(join(dispatch.accountHome, ".factory-trial-")),
          log = mkdir(batch, id);
        let cleanup = true;
        try {
          const repo = mkdir(root, "source"),
            judgeDir = mkdir(root, "judge");
          const refs = input.fixture ? evalCheckout(git, factory, pin, repo, log, input.patch) : plantPilot(git, factory, pin, repo);
          const dirs = createAttempt({
            runRoot: join(root, "runs"),
            stateRoot: dispatch.stateRoot,
            project: repo,
            accountHome: dispatch.accountHome,
            attemptId: id,
            role,
            stage: role === "triage" ? "triage" : "spec",
          });
          checkoutSnapshot(git, repo, refs.base, dirs.worktree);
          const stage = stageBlindInputs(git, factory, pin, role, input, dirs.taskDir, refs);
          const task = JSON.parse(readFileSync(join(dirs.taskDir, "task.json"), "utf8"));
          const triage = role === "spec-lead" ? JSON.parse(readFileSync(join(dirs.taskDir, "triage.json"), "utf8")) : undefined;
          const fields = input.brief as Partial<BriefInput>;
          const brief: BriefInput = {
            ...fields,
            taskId: fields.taskId ?? triage?.taskId ?? task.externalId,
            round: fields.round ?? 1,
            baseSha: refs.base,
            specSet: stage.specSet,
            routing: fields.routing ?? routing,
            project: {
              name: "factory-pilot",
              stack: "bun",
              isNew: false,
              fixtures: [],
              securityGlobs: [],
              migrationGlobs: [],
              ...fields.project,
              commands: { test: "bun test", ...fields.project?.commands },
            },
          };
          if (fields.previous?.findings)
            brief.previous = {
              ...fields.previous,
              findings: fields.previous.findings.map((v) => ({ ...v, path: join(dirs.taskDir, v.path) })),
            };
          const taskHash = bundleDigest(dirs.taskDir);
          const source = mkdir(log, "factory");
          checkoutSnapshot(git, factory, pin, source);
          const canary = crypto.randomUUID();
          writeFileSync(join(source, "skills/_shared/evals", crypto.randomUUID() + ".txt"), canary, { flag: "wx", mode: 0o400 });
          const model = role === "triage" ? config.agents.triage : config.agents.spec;
          const launch = async (
            session: string,
            attempt: typeof dirs,
            selected: typeof members,
            logDir: string,
            estimateKey: string,
            register: boolean,
          ) => {
            const cap = ledger.reserve(
              session,
              trialKey,
              estimateKey,
              selected.length ? "spec-team" : role,
              model.model,
              register ? { revision: pin, id } : undefined,
            );
            cleanup = false;
            const result = await runAgent(
              {
                ...model,
                runId: session,
                prompt: "",
                worktreePath: attempt.worktree,
                logDir,
                evaluationLimits: cap,
                instructions: { repo, baseSha: refs.base, paths: PROJECT_INSTRUCTION_PATHS },
                skill: {
                  dirs: attempt,
                  brief,
                  members: selected,
                  factoryRepo: source,
                  factoryCommit: pin,
                  toolDirs: config.pilot.toolDirs,
                  ...(role === "spec-lead" ? { namedLeadEvaluation: true as const } : {}),
                },
              },
              dispatch,
            );
            cleanup = result.noKnownSurvivors && !result.quarantineWorktree;
            const actual = ledger.settle(session, result.usage?.harness === "claude" ? result.usage : null, result.outcome);
            return { result, actual };
          };
          let handoff = false;
          if (promotion) {
            const first = crypto.randomUUID();
            const initial = createAttempt({
              runRoot: join(root, "runs"),
              stateRoot: dispatch.stateRoot,
              project: repo,
              accountHome: dispatch.accountHome,
              attemptId: first,
              role,
              stage: "spec",
            });
            checkoutSnapshot(git, repo, refs.base, initial.worktree);
            stageBlindInputs(git, factory, pin, role, input, initial.taskDir, refs);
            const { result, actual } = await launch(first, initial, [], mkdir(batch, first), key + "/handoff", true);
            if (actual.overshootInput || actual.overshootOutput) throw new Error("batch stopped after a measured overshoot");
            if (!cleanup) throw new Error("unverified handoff cleanup");
            const text = result.resultText ?? "";
            handoff =
              result.outcome === "completed" &&
              !result.diagnostics.length &&
              result.observedModel === model.model &&
              result.sessionId === first &&
              !!result.bundleHash &&
              text.startsWith("BLOCKED: team required") &&
              /\btier\s*[:=]?\s*L\b/i.test(text) &&
              members.every((member) => text.includes(member)) &&
              (await claudeChildStarts(dispatch.stateRoot, dispatch.harnessHomes.claude, first)).size === 0 &&
              readdirSync(initial.outDir).length === 0 &&
              bundleDigest(initial.taskDir) === taskHash;
            if (handoff) await inspectBlindStream(result.stdoutPath, canary, initial.worktree);
            if (!handoff) {
              const report = JSON.stringify({ session: first, actual, handoff });
              ledger.db.run("UPDATE trials SET status='failed',report=? WHERE key=?", [report, trialKey]);
              console.log(JSON.stringify({ trial: trialKey, status: "failed", handoff }));
              continue;
            }
          }
          const { result, actual } = await launch(id, dirs, members, log, promotion ? key + "/team" : key, !promotion);
          const overshoot = !!(actual.overshootInput || actual.overshootOutput);
          let passed = false,
            report: object = { actual };
          try {
            if (
              !cleanup ||
              result.outcome !== "completed" ||
              result.observedModel !== model.model ||
              result.sessionId !== id ||
              result.diagnostics.length ||
              !result.bundleHash
            )
              throw new Error("incomplete or mismatched contestant session");
            if (bundleDigest(dirs.taskDir) !== taskHash) throw new Error("staged fixture changed");
            const inspected = await inspectBlindStream(result.stdoutPath, canary, dirs.worktree);
            const author = { role, sessionId: id },
              identity = { taskId: brief.taskId, attemptId: id, ...author };
            const expected = new Map<string, OutputAuthor>(
              (role === "triage" ? ["triage.json"] : ["spec.md", "spec-lead.json"]).map((p) => [p, author]),
            );
            const writes = await claudeWrites(identity, dispatch.stateRoot, dispatch.harnessHomes.claude, dirs.outDir);
            if (members.length)
              await authenticateTeam(
                dirs,
                members,
                identity,
                dispatch.stateRoot,
                dispatch.harnessHomes.claude,
                result.stdoutPath,
                expected,
                writes,
              );
            const files = collectOutputs(dirs, identity, expected, writes);
            const children = await claudeChildStarts(dispatch.stateRoot, dispatch.harnessHomes.claude, id);
            const tracked = new Set(
              runGit(git, repo, ["ls-tree", "-r", "-z", "--name-only", refs.base]).toString().split("\0").filter(Boolean),
            );
            const clean = !runGit(git, dirs.worktree, ["status", "--porcelain"]).length;
            const checks = deterministicBatchOne({
              ...row,
              brief: runBrief(dirs, brief, !!members.length),
              files,
              clean,
              inspected,
              children: children.size,
              team: { handoff, starts: [...children.values()], authors: expected },
              tracked,
              skills: dirs.skillsDir,
            });
            const output = Object.fromEntries([...files].map(([path, b]) => [path, b.toString()]));
            writeFileSync(join(log, "submission.json"), JSON.stringify(output), { flag: "wx", mode: 0o600 });
            const judgeChecks = row.checks.filter((c) => c.kind === "judge");
            const fixtures = {
              task: Object.fromEntries(Object.keys(input.files).map((p) => [p, readFileSync(join(dirs.taskDir, p), "utf8")])),
              source: Object.fromEntries(
                [...tracked]
                  .filter((p) => !p.startsWith(".") && !p.endsWith(".lock"))
                  .map((p) => [p, runGit(git, repo, ["show", refs.base + ":" + p]).toString()]),
              ),
            };
            const judge = judgeChecks.length ? await runCodexJudge(dispatch, judgeDir, log, fixtures, output, judgeChecks) : undefined;
            const graded = { ...checks, ...judgeGrades(judge?.grades, row.checks, files) };
            passed = Object.keys(graded).length === row.checks.length && Object.values(graded).every(Boolean);
            report = { actual, result: result.outcome, checks: graded, judge, session: id };
          } catch (error) {
            report = { actual, session: id, error: (error as Error).message };
          }
          const status = passed ? "passed" : "failed";
          ledger.db.run("UPDATE trials SET status=?,report=? WHERE key=?", [status, JSON.stringify(report), trialKey]);
          console.log(JSON.stringify({ trial: trialKey, status, ...report }));
          if (overshoot) throw new Error("batch stopped after a measured overshoot");
        } finally {
          if (cleanup) rmSync(root, { recursive: true, force: true });
        }
      }
    }
  }
  for (const role of ["builder", "spec-reviewer", "security-auditor"] as const) {
    const cases = JSON.parse(pinnedFixture(git, factory, pin, `skills/${role}/evals/evals.json`).toString()).cases;
    for (const c of flattenCases(cases)) {
      const input = caseInput(git, factory, pin, role, c.id, c.variant);
      console.log(
        JSON.stringify({
          case: c.id,
          variant: c.variant,
          harness: "codex",
          trials: 3,
          missing: requiredProofs("codex", role, [], String(input.brief.stage), dispatch),
        }),
      );
    }
  }
  const failed = ledger.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM trials WHERE status='failed'").get()!.n;
  if (failed) process.exitCode = 1;
  else if (skipped) process.exitCode = 2;
}
try {
  await batchOne();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  const sessions = ledger.db
    .query("SELECT id,trial,model,estimate_input,estimate_output,actual_input,actual_output,outcome FROM sessions ORDER BY rowid")
    .all();
  const trials = ledger.db.query("SELECT key,status FROM trials ORDER BY key").all();
  console.log(JSON.stringify({ usage: ledger.totals(), sessions, trials }));
  ledger.db.close();
}
