import { sessionUuid } from "../dispatch/validation";
import { spawn } from "node:child_process";
import { meteredJob, recordUsage, recordInterrupted } from "../usage/store";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { config } from "../../factory.config";
import { loadDispatchConfig, runAgent, type RunResult } from "../dispatch";
import { assertPrivateDir } from "../dispatch/config";
import { runGit } from "../dispatch/git";
import { PROJECT_INSTRUCTION_PATHS } from "../dispatch/instructions";
import { assertRepoPath } from "../github/commit";
import { createWorktree, removeWorktree } from "../orca/worktree";
import type { Attempt, Store, Task } from "./store";
import { createAttempt, checkoutSnapshot } from "../dispatch/attempt";
import { claudeWrites } from "../dispatch/claude-writes";
import { codexWrites } from "../dispatch/codex-writes";
import { collectOutputs, outputDigest, OutputIntegrityError } from "../dispatch/output";
import { requireSkillProofs, SkillProofMissing } from "../dispatch/skill-launch";
import { archiveCollection, pinFactoryCommit, type Collection } from "./skill-store";
import { expectedFiles, skillInputs, skillRoles, stageInputs } from "./skill-inputs";
import { InvalidSkillOutput, validateSkillOutput } from "./skill-validation";
import { loadVerifyConfig, prepareScratchRepo } from "../verify/preview";
import { AgentFailed, Uncertain } from "./machine";

type Role = keyof typeof config.agents;
const factoryRepo = join(import.meta.dir, "../..");
interface Job {
  input: ReturnType<typeof skillInputs>;
  factoryCommit: string;
  testPassed: boolean;
  id: string;
  role: Role;
  head: string;
  base: string;
  prompt: string;
  agent?: (typeof config.agents)[Role];
}
export interface WorkerOutput {
  collection?: Collection;
  result: RunResult;
  files: { path: string; content: string }[];
}
function jobDir(id: string, stateRoot: string) {
  if (!sessionUuid.test(id)) throw new Error("invalid worker attempt id");
  return join(stateRoot, "jobs", id);
}

/** The pilot's test discovery, executable scripts, dependencies and static-analysis policy are owner-controlled. */
export function protectsChecks(path: string) {
  const name = path.split("/").at(-1)!.toLowerCase();
  return /^(package\.json|bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.json|biome\.jsonc?|eslint\.config\..+|\.eslintrc.*|\.eslintignore|\.gitignore)$/.test(name)
    || path.toLowerCase().split("/").includes("node_modules");
}

export function changes(path: string): WorkerOutput["files"] {
  const list = (...args: string[]) => runGit("/usr/bin/git", path, args).toString().split("\0").filter(Boolean);
  if (list("diff", "--diff-filter=D", "--name-only", "-z", "HEAD").length) throw new Uncertain("builder deleted a tracked file");
  const paths = [
    ...new Set([...list("diff", "--name-only", "-z", "HEAD"), ...list("ls-files", "--others", "--exclude-standard", "-z")]),
  ];
  if (paths.length > 40) throw new Error("unexpected number of builder files");
  let size = 0;
  return paths.map((name) => {
    assertRepoPath(name);
    if (protectsChecks(name)) throw new Uncertain(`builder changed check configuration: ${name}`);
    if (
      name.split("/").some((p) => p.startsWith(".")) ||
      name.startsWith("docs/specs/") ||
      name === "AGENTS.md" ||
      name === "CLAUDE.md"
    )
      throw new Error(`builder changed a protected path: ${name}`);
    const file = join(path, name);
    const st = lstatSync(file);
    size += st.size;
    if (realpathSync(file) !== file || !st.isFile() || st.nlink !== 1 || size > 1_048_576)
      throw new Error(`unsafe builder output ${name}`);
    return { path: name, content: readFileSync(file).toString("base64") };
  });
}

async function work(id: string) {
  const dir = jobDir(id, config.stateRoot);
  assertPrivateDir(dir, config.stateRoot);
  // An exclusive claim survives controller death and two concurrent launchers.
  writeFileSync(join(dir, "claim"), String(process.pid), { flag: "wx", mode: 0o600 });
  const finish = (value: unknown) => {
    writeFileSync(join(dir, "result.tmp"), JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(join(dir, "result.tmp"), join(dir, "result.json"));
  };
  try {
    const job: Job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
    const dispatch = loadDispatchConfig({ agentWriteRoots: [config.workspaceRoot] });
    const agent = job.agent ?? config.agents[job.role];
    requireSkillProofs(agent.harness, job.input.role, job.input.members);
    const wt = job.role === "builder"
      ? await createWorktree(dispatch.executables.orca, `factory-${id}`, config.pilot.path, job.input.inputSha) : undefined;
    let quarantine = true;
    let output: WorkerOutput;
    const dirs = createAttempt({ accountHome: dispatch.accountHome, stateRoot: dispatch.stateRoot,
      runRoot: join(dispatch.accountHome, ".software-factory-runs"), project: wt?.path ?? config.pilot.path,
      attemptId: id, role: job.input.role, stage: job.input.stage });
    try {
      if (!wt) checkoutSnapshot(dispatch.executables.git, config.pilot.path, job.input.inputSha, dirs.worktree);
      if (dirs.scratchRepo) {
        checkoutSnapshot(dispatch.executables.git, config.pilot.path, job.input.inputSha, dirs.scratchRepo);
        const verify = loadVerifyConfig(dispatch, {toolDirs: config.pilot.toolDirs, toolRoots: config.pilot.toolDirs, agentWriteRoots: [config.workspaceRoot]});
        try { await prepareScratchRepo(verify, {id, checkout: dirs.scratchRepo, scratch: dirs.scratchDir, logDir: dir, commands: config.pilot.commands}); }
        catch (error) { throw new Uncertain("scratch setup requires inspection: " + (error as Error).message); }
        finally { verify.egress.close(); }
      }
      const current = runGit(dispatch.executables.git, dirs.worktree, ["rev-parse", "HEAD"]).toString().trim();
      if (current !== job.input.inputSha) throw new Uncertain("checkout does not match intended skill input");
      const brief = stageInputs(dirs, job.input);
      const result = await runAgent({
        ...agent, runId: id, worktreePath: dirs.worktree, logDir: dir, prompt: "",
        skill: { brief, dirs, members: job.input.members, toolDirs: config.pilot.toolDirs, factoryRepo, factoryCommit: job.factoryCommit },
        instructions: { repo: config.pilot.path, baseSha: job.base, paths: PROJECT_INSTRUCTION_PATHS },
      }, dispatch);
      output = { result, files: [] };
      if (!result.quarantineWorktree && result.noKnownSurvivors && result.outcome === "completed" && !result.resultText?.startsWith("BLOCKED: ")) {
        if (!result.bundleHash || !result.sessionId) throw new Uncertain("skill output lacks trusted session or bundle hash");
        const identity = { taskId: brief.taskId, attemptId: id, role: dirs.role, sessionId: result.sessionId };
        const author = { role: dirs.role, sessionId: result.sessionId };
        const expected = new Map(expectedFiles[job.role].map(path => [path, author]));
        const home = dispatch.harnessHomes[agent.harness];
        let captured: Map<string, Buffer>;
        try {
          const writes = await (agent.harness === "claude" ? claudeWrites : codexWrites)(identity, dispatch.stateRoot, home, dirs.outDir);
          captured = collectOutputs(dirs, identity, expected, writes);
        } catch (error) {
          throw new OutputIntegrityError("skill output integrity escalation: " + (error as Error).message);
        }
        const files = wt ? changes(wt.path) : [];
        validateSkillOutput(job.input, dirs, captured, files.map(f => f.path), dispatch.executables.git, job.testPassed);
        output = { result, files, collection: { attempt: id, role: dirs.role, base: job.base, head: job.head,
          bundleHash: result.bundleHash, round: brief.round,
          files: [...captured].map(([path, bytes]) => ({ path, role: author.role, session: author.sessionId,
            sha256: outputDigest(bytes), base64: bytes.toString("base64") })) } };
      }
      quarantine = result.quarantineWorktree || !result.noKnownSurvivors;
    } finally {
      if (!quarantine) {
        rmSync(dirs.root, { recursive: true });
        if (wt) await removeWorktree(dispatch.executables.orca, wt.id);
      }
    }
    finish({ output });
  } catch (e) {
    finish({ error: String(e), invalid: e instanceof InvalidSkillOutput, escalated: e instanceof Uncertain || e instanceof SkillProofMissing || e instanceof OutputIntegrityError });
  }
}

function launchSupervisor(dir: string, id: string, stateRoot: string) {
  const fd = openSync(join(dir, "supervisor.log"), "a", 0o600);
  try {
    const owner = userInfo();
    // Concurrent launchers may race to claim the job, but the exclusive claim admits only one harness.
    const proc = spawn(process.execPath, [import.meta.path, id], {
      detached: true, cwd: stateRoot,
      env: { PATH: "/usr/bin:/bin", HOME: owner.homedir, USER: owner.username, LOGNAME: owner.username },
      stdio: ["ignore", fd, fd],
    });
    proc.unref();
    return proc.pid;
  } finally {
    closeSync(fd);
  }
}

export class WorkerLoginError extends Error {}
export async function dispatchWorker(
  store: Store,
  task: Task,
  attempt: Attempt,
  role: Role,
  prompt: string,
  observe: (event: string, id: string) => void,
  stateRoot = config.stateRoot,
  launch = launchSupervisor,
): Promise<WorkerOutput> {
  const dir = jobDir(attempt.id, stateRoot);
  const job = { id: attempt.id, role, base: task.base, head: task.head, prompt, agent: config.agents[role] };
  const snapshot = () => meteredJob(dir, { ...job, agent: config.agents[role] });
  const auditWarning = (cause: unknown) => console.warn(`usage audit failed for ${attempt.id}`, cause);
  const recordInterruption = async () => {
    try { await recordInterrupted(store.db, task, snapshot(), dir, stateRoot); }
    catch (cause) { auditWarning(cause); }
  };
  const interrupted = async (error: Error): Promise<never> => {
    await recordInterruption();
    throw error;
  };
  const claim = join(dir, "claim");
  const receipt = join(dir, "result.json");
  if (!attempt.fresh) observe("recover-worker", attempt.id);
  let launcherPid: number | undefined;
  if (!existsSync(claim) && !existsSync(receipt)) {
    mkdirSync(dir, { mode: 0o700, recursive: true });
    const path = join(dir, "job.json");
    const commit = runGit("/usr/bin/git", factoryRepo, ["rev-parse", "HEAD"]).toString().trim();
    const input = skillInputs(store, task, role, prompt);
    const check = store.db.query<{result: string}, [number]>(
      "SELECT result FROM attempts WHERE task=? AND action='head-checks' AND result IS NOT NULL ORDER BY visit DESC LIMIT 1",
    ).get(task.id);
    const proof = check && JSON.parse(check.result);
    const testPassed = !!(proof && proof.base === task.base && proof.tested === task.head && proof.head === task.head &&
      proof.checks.some((c: {name: string; pass: boolean; detail: string}) => c.name === "test" && c.pass && c.detail.startsWith("exit 0\n")));
    const job: Job = { id: attempt.id, role, base: task.base, head: task.head, prompt, agent: config.agents[role], input,
      factoryCommit: pinFactoryCommit(store.db, task.id, commit), testPassed };
    if (!existsSync(path)) {
      const tmp = join(dir, `job-${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 });
      renameSync(tmp, path);
    } else {
      const published: Job = JSON.parse(readFileSync(path, "utf8"));
      if (published.base !== job.base || published.head !== job.head || published.prompt !== prompt || published.role !== role ||
          published.factoryCommit !== job.factoryCommit || JSON.stringify(published.input) !== JSON.stringify(input) || published.testPassed !== testPassed)
        throw new Uncertain("worker job identity changed");
    }
    launcherPid = launch(dir, attempt.id, stateRoot);
  }
  const start = Date.now();
  const timeout = config.agents[role].timeoutMs + 120_000;
  let sawStart = false;
  for (;;) {
    const stdout = join(dir, `${attempt.id}.stdout.jsonl`);
    if (!sawStart && existsSync(stdout) && lstatSync(stdout).size > 0) {
      sawStart = true;
      if (attempt.fresh) observe("dispatched", attempt.id);
    }
    if (existsSync(join(dir, "result.json"))) break;
    if (Date.now() - start > timeout) return interrupted(new Uncertain(`worker completion is uncertain for ${attempt.id}`));
    if (Date.now() - start > 5000) {
      const claimedPid = existsSync(claim) ? Number(readFileSync(claim, "utf8")) : 0;
      const pid = claimedPid > 1 ? claimedPid : launcherPid;
      if (!pid || pid <= 1) return interrupted(new Uncertain(`worker startup is uncertain for ${attempt.id}`));
      try {
        process.kill(pid, 0);
      } catch {
        if (!existsSync(join(dir, "result.json"))) return interrupted(new Uncertain(`unsettled worker disappeared: ${attempt.id}`));
      }
    }
    await Bun.sleep(150);
  }
  const reply: { output?: WorkerOutput; error?: string; invalid?: boolean; escalated?: boolean } = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  if (reply.invalid || reply.escalated || !reply.output) await recordInterruption();
  if (reply.invalid) throw new InvalidSkillOutput(reply.error ?? "invalid skill output");
  if (reply.escalated) throw new Uncertain(reply.error ?? "worker requires inspection");
  if (!reply.output) throw new AgentFailed(reply.error ?? "missing worker result");
  const { result } = reply.output;
  if (result.runId !== attempt.id) throw new Uncertain("worker receipt belongs to another attempt");
  const failure = workerFailure(result, dir);
  try { await recordUsage(store.db, task, snapshot(), result, stateRoot); }
  catch (cause) {
    if (!failure) throw cause;
    auditWarning(cause);
  }
  if (failure) throw failure;
  if (!result.resultText!.startsWith("BLOCKED: ")) {
    const c = reply.output.collection;
    if (!c || c.attempt !== attempt.id || c.base !== task.base || c.head !== task.head || c.role !== skillRoles[role] ||
        c.bundleHash !== result.bundleHash || c.files.length !== expectedFiles[role].length ||
        !expectedFiles[role].every(name => c.files.some(f => f.path === name && f.session === result.sessionId && f.role === c.role)))
      throw new Uncertain("worker receipt lacks the matching authenticated skill collection");
    archiveCollection(store.db, task.id, c);
  }
  return reply.output;
}
function workerFailure(result: RunResult, dir: string) {
  if (result.outcome === "failed" && !result.quarantineWorktree && result.resultText?.startsWith("Not logged in"))
    return new WorkerLoginError("factory harness needs its dedicated login");
  if (result.quarantineWorktree || result.outcome === "timed_out")
    return new Uncertain(`worker ${result.runId} needs inspection, see ${dir}`);
  if (result.outcome !== "completed" || !result.resultText)
    return new AgentFailed(`worker ${result.runId} ${result.outcome}, see ${dir}`);
  return null;
}
if (import.meta.main) await work(process.argv[2] ?? "");
