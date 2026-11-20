import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../factory.config";
import { runAgent, loadDispatchConfig } from "../src/dispatch";
import { checkoutSnapshot, createAttempt } from "../src/dispatch/attempt";
import { assertPrivateDir } from "../src/dispatch/config";
import { bundleDigest } from "../src/dispatch/bundle";
import { claudeWrites } from "../src/dispatch/claude-writes";
import { runGit } from "../src/dispatch/git";
import { PROJECT_INSTRUCTION_PATHS } from "../src/dispatch/instructions";
import { collectOutputs } from "../src/dispatch/output";
import { readJsonl, isRecord } from "../src/dispatch/jsonl";
import { requiredProofs } from "../src/dispatch/skill-launch";
import { flattenCases, judgeGrades } from "./batch-one-cases";
import { DollarBudget } from "./eval-dollar-budget";
import { runCodexJudge } from "./eval-codex-judge";
import { evalCheckout, pinnedFixture } from "./eval-checkout";
import { caseInput, inspectBlindStream, stageBlindInputs } from "./eval-inputs";
import { specialistProject } from "./eval-pilot";
import { specialistChecks } from "./eval-specialist-checks";
import { planChecks, uiChecks, verifierChecks } from "./eval-verifier-checks";
import { stageUiEvidence, verifierPilot } from "./eval-verifier-pilot";
import Ajv2020 from "ajv/dist/2020";

const d = loadDispatchConfig({ agentWriteRoots: [config.workspaceRoot] }),
  git = d.executables.git;
const root = join(d.stateRoot, "evaluations", "v1-step-4b-batch-2"),
  factory = realpathSync(join(import.meta.dir, ".."));
assertPrivateDir(root, d.stateRoot);
const pin = runGit(git, factory, ["log", "-1", "--format=%H", "HEAD", "--", "skills"]).toString().trim();
const ledger = new DollarBudget(join(root, "usage.sqlite"));
const make = (p: string) => {
  mkdirSync(p, { mode: 0o700 });
  return p;
};
const save = (p: string, data: unknown) => writeFileSync(p, JSON.stringify(data), { flag: "wx", mode: 0o600 });
async function run() {
  const selected = process.argv[2];
  if (process.argv.length > 3) throw new Error("expected a single case or variant");
  for (const role of ["architect", "infra", "frontend", "threat-modeler", "verifier"] as const) {
    const verifier = role === "verifier";
    const gate = requiredProofs("claude", verifier ? "verifier" : "spec-lead", verifier ? [] : [role], verifier ? "judge" : "spec", d);
    if (gate.length) throw new Error("specialist proof missing: " + gate.join(", "));
    const catalog = JSON.parse(pinnedFixture(git, factory, pin, "skills/" + role + "/evals/evals.json").toString());
    const agent = verifier ? { model: "claude-sonnet-5-5", effort: "high" as const } : config.specTeam[role];
    for (const row of flattenCases(catalog.cases)) {
      const input = caseInput(git, factory, pin, role, row.id, row.variant);
      const caseKey = row.id + (row.variant ? "/" + row.variant : "");
      if (selected && selected !== caseKey) continue;
      const planning = row.id === "verifier-01-plan-by-tag",
        ui = row.id === "verifier-03-judge-ui-capture";
      const accepted = ui
        ? ledger.db
            .query<{ id: string }, []>(
              "SELECT id FROM trials WHERE key LIKE 'verifier-01-plan-by-tag#%' AND status='passed' ORDER BY key LIMIT 1",
            )
            .get()
        : null;
      if (ui && !accepted) {
        console.log(JSON.stringify({ case: caseKey, refused: "no accepted verifier-01 plan" }));
        continue;
      }
      for (let trial = 1; trial <= 2; trial++) {
        const key = caseKey + "#" + trial;
        const prior = ledger.db
          .query<{ status: string }, [string]>("SELECT status FROM trials WHERE key=?")
          .get(key);
        if (prior) {
          if (prior.status === "started") throw new Error("reconcile " + key);
          if (prior.status !== "failed") break;
          continue;
        }
        const id = crypto.randomUUID(),
          proj = (input.brief as { project: { isNew: boolean } }).project;
        const local = mkdtempSync(join(d.accountHome, ".factory-trial-")),
          repo = make(join(local, "source")),
          logs = make(join(root, id));
        const refs =
          ui || planning
            ? verifierPilot(git, factory, pin, root, repo)
            : verifier
              ? evalCheckout(git, factory, pin, repo, logs, input.patch)
              : specialistProject(git, factory, pin, repo, role, !proj.isNew);
        const dirs = createAttempt({
          role: verifier ? "verifier" : "spec-lead",
          stage: verifier ? String(input.brief.stage) : "spec",
          project: repo,
          runRoot: join(local, "runs"),
          stateRoot: d.stateRoot,
          accountHome: d.accountHome,
          attemptId: id,
        });
        checkoutSnapshot(git, repo, verifier ? refs.head : refs.base, dirs.worktree);
        const staged = stageBlindInputs(git, factory, pin, role, input, dirs.taskDir, refs);
        if (ui && accepted) {
          const output = JSON.parse(readFileSync(join(root, accepted.id, "submission.json"), "utf8"));
          await stageUiEvidence(d, root, dirs.taskDir, refs, Buffer.from(output["verification/plan.json"]), factory, repo);
        }
        let retried = false;
        if (verifier && row.variant === "sound-evidence") {
          const first = createAttempt({
            role: "verifier",
            stage: "judge",
            project: repo,
            runRoot: join(local, "runs"),
            stateRoot: d.stateRoot,
            accountHome: d.accountHome,
            attemptId: crypto.randomUUID(),
          });
          stageBlindInputs(git, factory, pin, role, input, first.taskDir, refs);
          const invalid = { schemaVersion: 1, attemptId: first.root.split("/").at(-1) };
          const validate = new Ajv2020({ strictTypes: false, allowUnionTypes: true }).compile(JSON.parse(pinnedFixtureSchema()));
          retried = !validate(invalid) && first.root !== dirs.root && bundleDigest(first.taskDir) === bundleDigest(dirs.taskDir);
          save(join(logs, "retry-control.json"), {
            first: first.root.split("/").at(-1),
            second: id,
            invalid,
            firstHash: bundleDigest(first.taskDir),
            retryHash: bundleDigest(dirs.taskDir),
            retried,
          });
          if (!retried) throw new Error("invalid verifier retry preflight");
        }
        const taskHash = bundleDigest(dirs.taskDir);
        const source = make(join(logs, "factory"));
        checkoutSnapshot(git, factory, pin, source);
        const canary = crypto.randomUUID();
        writeFileSync(join(source, "skills/_shared/evals", canary + ".txt"), canary, { flag: "wx", mode: 0o400 });
        const taskId = String(
          input.brief.taskId ?? (verifier ? JSON.parse(readFileSync(join(dirs.taskDir, "spec-lead.json"), "utf8")).taskId : "task-" + id),
        );
        const brief = {
          taskId,
          round: 1,
          baseSha: refs.base,
          ...(verifier
            ? {
                headSha: refs.head,
                specSet: staged.specSet,
                ...(!planning
                  ? { captureAttemptId: JSON.parse(readFileSync(join(dirs.taskDir, "verification/evidence/index.json"), "utf8")).attemptId }
                  : {}),
              }
            : {}),
          project: { name: "project", stack: "bun", commands: {}, fixtures: [], securityGlobs: [], migrationGlobs: [], ...proj },
          routing: {
            S: { builder: "Sol 6.2", codeReviewer: "Opus 5.5" },
            M: { builder: "Sonnet 5.5", codeReviewer: "Sol 6.2" },
            L: { builder: "Opus 5.5", codeReviewer: "GPT-6.2-Astra" },
          },
        };
        const limit = ledger.reserve(id, key, caseKey, role, agent.model, { revision: pin, id });
        const result = await runAgent(
          {
            harness: "claude",
            ...agent,
            runId: id,
            logDir: logs,
            worktreePath: dirs.worktree,
            prompt: "",
            timeoutMs: 900000,
            evaluationLimits: limit,
            instructions: { repo, baseSha: refs.base, paths: PROJECT_INSTRUCTION_PATHS },
            skill: {
              dirs,
              brief,
              members: [],
              ...(!verifier ? { evaluationMember: role } : {}),
              factoryRepo: source,
              factoryCommit: pin,
              toolDirs: config.pilot.toolDirs,
            },
          },
          d,
        );
        const actual = ledger.settle(id, result.usage?.harness === "claude" ? result.usage : null, result.outcome);
        let report: object,
          status = "failed";
        try {
          if (
            result.outcome !== "completed" ||
            result.sessionId !== id ||
            result.observedModel !== agent.model ||
            !result.bundleHash ||
            result.diagnostics.length ||
            result.quarantineWorktree ||
            !result.noKnownSurvivors
          )
            throw new Error("incomplete specialist: " + result.diagnostics.join(", "));
          await inspectBlindStream(result.stdoutPath, canary, dirs.worktree);
          const name = planning
            ? "verification/plan.json"
            : verifier
              ? "verification/results.json"
              : role === "threat-modeler"
                ? "threat-model.md"
                : role === "architect"
                  ? "architecture.md"
                  : role + ".md";
          const paths = [...new Bun.Glob("projects/*/" + id + ".jsonl").scanSync(d.harnessHomes.claude)];
          let system = false;
          if (!verifier && paths.length === 1)
            for await (const item of readJsonl(join(d.harnessHomes.claude, paths[0]!))) {
              if (item.kind !== "record") throw new Error("invalid specialist transcript");
              const e = item.value;
              if (e.type === "api-request-shape" && isRecord(e.shape)) {
                const body = JSON.stringify(e.shape.system);
                system ||=
                  body.includes("factory_skill") &&
                  body.includes("<factory_run>") &&
                  body.includes(join(dirs.outDir, name)) &&
                  body.includes(join(dirs.taskDir, "team-brief.md"));
              }
            }
          if (!verifier && !system) throw new Error("missing specialist system brief");
          const who = { role, sessionId: id, attemptId: id, taskId };
          const writes = await claudeWrites(who, d.stateRoot, d.harnessHomes.claude, dirs.outDir);
          const files = collectOutputs(dirs, who, new Map(row.variant === "stale-evidence" ? [] : [[name, who]]), writes);
          const tracked = runGit(git, repo, ["ls-tree", "-r", "--name-only", "-z", refs.head]).toString().split("\0").filter(Boolean);
          const intact =
            !readdirSync(dirs.scratchDir).length &&
            bundleDigest(dirs.taskDir) === taskHash &&
            !runGit(git, dirs.worktree, ["status", "--porcelain"]).length;
          let noCommands = true;
          if (verifier)
            for await (const line of readJsonl(result.stdoutPath)) {
              if (line.kind !== "record") throw new Error("invalid verifier event");
              const e = line.value;
              if (
                isRecord(e.message) &&
                Array.isArray(e.message.content) &&
                e.message.content.some(
                  (t) => isRecord(t) && t.type === "tool_use" && !["Read", "Write", "Edit", "Glob", "Grep"].includes(String(t.name)),
                )
              )
                noCommands = false;
            }
          const tree = new Map(
            tracked.filter((p) => !p.endsWith(".lock")).map((p) => [p, runGit(git, repo, ["show", refs.head + ":" + p]).toString()]),
          );
          const checks = planning
            ? planChecks(files, dirs.taskDir, dirs.skillsDir, refs, intact, tree)
            : ui
              ? uiChecks(files, dirs.taskDir, dirs.skillsDir, await observedImageHashes(d.harnessHomes.claude, id, dirs.taskDir))
              : verifier
                ? verifierChecks(
                    row.variant!,
                    row.checks,
                    files,
                    result.resultText ?? "",
                    dirs.taskDir,
                    dirs.skillsDir,
                    id,
                    refs.head,
                    noCommands,
                    retried,
                  )
                : specialistChecks(role, files.get(name)!.toString(), row.checks, dirs.skillsDir, new Set(tracked), intact);
          if (!intact) throw new Error("staged inputs, snapshot or scratch changed");
          const fixtures = {
            task: Object.fromEntries(
              [
                ...new Set([...Object.keys(input.files), ...(ui ? ["verification/plan.json", "verification/evidence/index.json"] : [])]),
              ].map((path) => [path, readFileSync(join(dirs.taskDir, path), "utf8")]),
            ),
            source: Object.fromEntries(tree),
          };
          if (row.variant === "stale-evidence") files.set("final-message.txt", Buffer.from(result.resultText ?? ""));
          const output = Object.fromEntries([...files].map(([k, v]) => [k, v.toString()]));
          const questions = row.checks.filter((c) => c.kind === "judge");
          save(join(logs, "submission.json"), output);
          save(join(logs, "grading-input.json"), { fixtures, output, checks, judgeChecks: questions });
          const judge = questions.length
            ? await runCodexJudge(d, make(join(local, "judge")), logs, fixtures, output, questions)
            : undefined;
          const graded = { ...checks, ...judgeGrades(judge?.grades, questions, files) };
          status = Object.keys(graded).length === row.checks.length && Object.values(graded).every(Boolean) ? "passed" : "failed";
          report = { session: id, actual, checks: graded, judge };
        } catch (e) {
          report = { session: id, actual, error: (e as Error).message };
        }
        ledger.db.run("UPDATE trials SET status=?,report=? WHERE key=?", [status, JSON.stringify(report), key]);
        console.log(JSON.stringify({ key, status, actual }));
        if (actual.overshootUsd) return;
        if (status === "passed") break;
      }
    }
  }
}
function pinnedFixtureSchema() {
  return runGit(git, factory, ["show", pin + ":skills/verifier/results.schema.json"]).toString();
}
async function observedImageHashes(home: string, id: string, task: string) {
  const paths = [...new Bun.Glob("projects/*/" + id + ".jsonl").scanSync(home)];
  if (paths.length !== 1) throw new Error("missing verifier transcript");
  const hashes = new Set<string>();
  for await (const line of readJsonl(join(home, paths[0]!))) {
    if (line.kind !== "record") throw new Error("invalid verifier transcript");
    const e = line.value;
    if (e.sessionId !== id) continue;
    if (
      e.type === "assistant" &&
      isRecord(e.message) &&
      Array.isArray(e.message.content) &&
      e.message.content.some((c) => isRecord(c) && c.type === "tool_use" && c.name === "Write")
    )
      break;
    const r = e.toolUseResult;
    if (
      e.type === "user" &&
      isRecord(r) &&
      r.type === "image" &&
      typeof r.filePath === "string" &&
      r.filePath.startsWith(join(task, "verification/evidence") + "/") &&
      typeof r.sha256 === "string"
    )
      hashes.add(r.sha256);
  }
  return hashes;
}
try {
  await run();
} finally {
  ledger.db.close();
}
