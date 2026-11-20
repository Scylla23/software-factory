import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../factory.config";
import { checkoutSnapshot, createAttempt } from "../src/dispatch/attempt";
import type { BriefInput } from "../src/dispatch/brief";
import { bundleDigest } from "../src/dispatch/bundle";
import { findCodexSessionFile } from "../src/dispatch/codex";
import { codexWrites } from "../src/dispatch/codex-writes";
import { runAgent, loadDispatchConfig } from "../src/dispatch";
import { assertPrivateDir } from "../src/dispatch/config";
import { runGit } from "../src/dispatch/git";
import { PROJECT_INSTRUCTION_PATHS } from "../src/dispatch/instructions";
import { collectOutputs } from "../src/dispatch/output";
import { requiredProofs } from "../src/dispatch/skill-launch";
import { isRecord, readJsonl } from "../src/dispatch/jsonl";
import { flattenCases } from "./batch-one-cases";
import { caseInput, revisionFixtureError, stageBlindInputs } from "./eval-inputs";
import { evalCheckout, pinnedFixture } from "./eval-checkout";

const dispatch = loadDispatchConfig({ agentWriteRoots: [config.workspaceRoot] });
const git = dispatch.executables.git,
  factory = realpathSync(join(import.meta.dir, ".."));
const pin = runGit(git, factory, ["log", "-1", "--format=%H", "HEAD", "--", "skills"]).toString().trim();
const mkdir = (p: string) => {
  mkdirSync(p, { mode: 0o700 });
  return p;
};
const store = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data), { flag: "wx", mode: 0o600 });

async function verifyBlind(path: string, canary: string) {
  for await (const line of readJsonl(path)) {
    if (line.kind !== "record" || JSON.stringify(line.value).includes(canary)) throw new Error("invalid blind trial evidence");
    const p = line.value.payload;
    if (isRecord(p) && ["function_call", "custom_tool_call"].includes(String(p.type)) && /(?:^|[\s/"'])evals\//.test(JSON.stringify(p)))
      throw new Error("contestant accessed an excluded eval directory");
  }
}

// Preserve the checked-out worktree until independent deterministic checks and cross-vendor grading finish.
export async function collectCodexTrials(batchTwo = false, selected?: string) {
  const batch = join(dispatch.stateRoot, "evaluations", batchTwo ? "v1-step-4b-batch-2" : "v1-step-4b-batch-1", "codex");
  mkdirSync(batch, { recursive: true, mode: 0o700 });
  assertPrivateDir(batch, dispatch.stateRoot);
  for (const role of ["builder", "security-auditor", "spec-reviewer"] as const) {
    const cases = JSON.parse(pinnedFixture(git, factory, pin, "skills/" + role + "/evals/evals.json").toString()).cases;
    for (const row of flattenCases(cases)) {
      const input = caseInput(git, factory, pin, role, row.id, row.variant);
      const stage = String(input.brief.stage);
      const missing = requiredProofs("codex", role, [], stage, dispatch);
      const key = row.id + (row.variant ? "/" + row.variant : "");
      if (selected && key !== selected) continue;
      if (batchTwo && (role === "builder" || row.variant === "lead-dropped-a-mitigation")) continue;
      if (missing.length) {
        console.log(JSON.stringify({ key, missing, trials: 3 }));
        continue;
      }
      if (!input.fixture) throw new Error("Codex case requires an explicit fixture");
      for (let trial = 1; trial <= 3; trial++) {
        let trialDir = join(batch, key.replace("/", "_") + "-" + trial);
        const preflight = join(trialDir, "preflight.json");
        if (existsSync(preflight) && JSON.parse(readFileSync(preflight, "utf8")).pin !== pin) trialDir += "-" + pin.slice(0, 12);
        if (existsSync(trialDir)) {
          const refusal = join(trialDir, "preflight.json");
          const previous = JSON.parse(readFileSync(existsSync(refusal) ? refusal : join(trialDir, "contestant.json"), "utf8"));
          if (
            runGit(git, factory, ["rev-parse", previous.pin + ":skills"]).toString() !==
            runGit(git, factory, ["rev-parse", pin + ":skills"]).toString()
          )
            throw new Error("previous trial skill tree differs");
          console.log(JSON.stringify(existsSync(refusal) ? previous : { key, trial, reused: previous.id }));
          continue;
        }
        mkdir(trialDir);
        const root = mkdtempSync(join(dispatch.accountHome, ".factory-trial-"));
        const repo = mkdir(join(root, "source")),
          id = crypto.randomUUID();
        const refs = evalCheckout(git, factory, pin, repo, trialDir, input.patch);
        const dirs = createAttempt({
          runRoot: join(root, "runs"),
          stateRoot: dispatch.stateRoot,
          accountHome: dispatch.accountHome,
          project: repo,
          attemptId: id,
          role,
          stage,
        });
        if (role !== "builder") checkoutSnapshot(git, repo, refs.head, dirs.worktree);
        if (dirs.scratchRepo) checkoutSnapshot(git, repo, refs.head, dirs.scratchRepo);
        const staged = stageBlindInputs(git, factory, pin, role, input, dirs.taskDir, refs);
        const fields = staged as unknown as BriefInput;
        const refused = revisionFixtureError(key, dirs.taskDir, fields.specSet?.sha256);
        if (refused) {
          const receipt = { key, trial, pin, refused };
          store(join(trialDir, "preflight.json"), receipt);
          console.log(JSON.stringify(receipt));
          continue;
        }
        const brief: BriefInput = {
          ...fields,
          project: {
            name: "factory-pilot",
            stack: "bun",
            fixtures: [],
            migrationGlobs: [],
            securityGlobs: [],
            ...(input.brief.project as object),
            isNew: false,
            commands: { test: "bun test" },
          },
          routing: {
            S: { builder: "Sol 6.2", codeReviewer: "Opus 5.5" },
            M: { builder: "Sonnet 5.5", codeReviewer: "Sol 6.2" },
            L: { builder: "Opus 5.5", codeReviewer: "GPT-6.2-Astra" },
          },
        };
        if (fields.previous) {
          brief.previous = { ...fields.previous };
          for (const k of ["verdict", "specSetDir", "buildReport"] as const)
            if (fields.previous[k]) brief.previous[k] = join(dirs.taskDir, fields.previous[k]!);
          if (fields.previous.findings)
            brief.previous.findings = fields.previous.findings.map((f) => ({ ...f, path: join(dirs.taskDir, f.path) }));
        }
        const source = mkdir(join(trialDir, "factory"));
        checkoutSnapshot(git, factory, pin, source);
        const canary = crypto.randomUUID();
        writeFileSync(join(source, "skills/_shared/evals", crypto.randomUUID() + ".txt"), canary, { flag: "wx", mode: 0o400 });
        const taskHash = bundleDigest(dirs.taskDir);
        const initialRefs = runGit(git, dirs.worktree, ["show-ref", "--head"]).toString();
        const route =
          role === "builder"
            ? config.agents.builder
            : { harness: "codex" as const, model: "gpt-6.2-astra", effort: "high" as const, timeoutMs: 900000 };
        store(join(trialDir, "start.json"), {
          id,
          key,
          trial,
          root,
          worktree: dirs.worktree,
          task: dirs.taskDir,
          out: dirs.outDir,
          skills: dirs.skillsDir,
          refs,
          initialRefs,
          pin,
          role,
          stage,
          brief,
        });
        const instructionsRepo = mkdir(join(trialDir, "project"));
        checkoutSnapshot(git, repo, refs.head, instructionsRepo);
        const result = await runAgent(
          {
            ...route,
            runId: id,
            prompt: "",
            worktreePath: dirs.worktree,
            logDir: trialDir,
            instructions: { repo: instructionsRepo, baseSha: refs.base, paths: PROJECT_INSTRUCTION_PATHS },
            skill: { dirs, brief, members: [], factoryRepo: source, factoryCommit: pin, toolDirs: config.pilot.toolDirs },
          },
          dispatch,
        );
        let error: string | undefined;
        try {
          if (
            result.outcome !== "completed" ||
            result.diagnostics.length ||
            result.quarantineWorktree ||
            !result.noKnownSurvivors ||
            result.observedModel !== route.model ||
            !result.sessionId ||
            !result.bundleHash
          )
            throw new Error("incomplete or quarantined contestant: " + result.diagnostics.join(", "));
          if (bundleDigest(dirs.taskDir) !== taskHash) throw new Error("staged inputs changed");
          const session = await findCodexSessionFile(join(dispatch.harnessHomes.codex, "sessions"), result.sessionId);
          if (!session) throw new Error("missing rollout");
          await verifyBlind(session, canary);
          const author = { role, sessionId: result.sessionId };
          const identity = { ...author, taskId: brief.taskId, attemptId: id };
          const output = role === "builder" ? "build-report.json" : "verdicts/" + role + ".json";
          const writes = await codexWrites(identity, dispatch.stateRoot, dispatch.harnessHomes.codex, dirs.outDir);
          const files = collectOutputs(dirs, identity, new Map([[output, author]]), writes);
          store(join(trialDir, "submission.json"), Object.fromEntries([...files].map(([k, b]) => [k, b.toString()])));
        } catch (err) {
          error = (err as Error).message;
        }
        const record = {
          id,
          pin,
          key,
          trial,
          session: result.sessionId,
          usage: result.usage,
          outcome: result.outcome,
          model: result.observedModel,
          quarantine: result.quarantineWorktree,
          error,
        };
        store(join(trialDir, "contestant.json"), record);
        console.log(JSON.stringify(record));
      }
    }
  }
}
if (import.meta.main) await collectCodexTrials(process.argv[2] === "--batch-two", process.argv[3]);
