import { closeSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { claudeArgs, parseClaudeStream } from "./claude";
import { codexArgs, codexReadable, codexSessionModel, findCodexSessionFile, parseCodexEvents } from "./codex";
import { assertPrivateDir, assertSafeDir, assertStateRootIsolated, type DispatchConfig, isUnder, managedSettingsProblems, planRunFiles, reserveRunFiles, tempRoots } from "./config";
import { buildProjectInstructions } from "./instructions";
import { readJsonl } from "./jsonl";
import { openRunMonitor, type RunMonitor } from "../orca/monitor";
import { gitWriteProtectedPaths } from "./git";
import { agentEnv, assertPolicySound, assertWorktreeWritable, effectiveDenyRead, type PolicyContext, type SandboxPolicy } from "./policy";
import { type AgentProcess, spawnAgentProcess, superviseRun, sweepWorktree } from "./process";
import type { RunOutcome, RunResult, RunSpec } from "./types";

export { loadDispatchConfig, type DispatchConfig } from "./config";
export type { RunResult, RunSpec } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_LABEL = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Runs one headless agent turn in a worktree and waits for it.
 * stdout goes straight to a log file so the raw stream survives a factory crash; logs are kept.
 * Throws only before anything starts (bad spec, aborted signal, unsafe config or log location).
 */
export async function runAgent(spec: RunSpec, config: DispatchConfig): Promise<RunResult> {
  if (!UUID.test(spec.runId)) throw new Error(`runId must be a lowercase UUID: ${spec.runId}`);
  if (spec.monitor && !AGENT_LABEL.test(spec.monitor.agent)) throw new Error(`monitor agent label must match ${AGENT_LABEL}: ${JSON.stringify(spec.monitor.agent)}`);
  spec.signal?.throwIfAborted();
  const worktree = realpathSync(spec.worktreePath);
  const executable = config.executables[spec.harness];
  let realExecutable: string | null = null;
  try {
    realExecutable = realpathSync(executable);
  } catch {
    // a missing executable surfaces as a failed spawn below
  }
  if (realExecutable && isUnder(realExecutable, worktree)) throw new Error(`executable ${realExecutable} is inside the worktree`);
  if (spec.harness === "claude") {
    const problems = managedSettingsProblems(config);
    if (problems.length > 0) throw new Error(`refusing Claude dispatch, managed settings would apply:\n${problems.join("\n")}`);
  }
  const agentWritable = [worktree, ...tempRoots()];
  const ctx: PolicyContext = { accountHome: config.accountHome, stateRoot: config.stateRoot, harnessHomes: Object.values(config.harnessHomes) };
  const denyRead = effectiveDenyRead(ctx, spec.extraDenyRead);
  const policy: SandboxPolicy = {
    denyRead,
    readable: spec.harness === "codex" && realExecutable ? codexReadable(realExecutable, denyRead) : [],
    denyWrite: gitWriteProtectedPaths(config.executables.git, worktree),
  };
  assertPolicySound(policy, ctx);
  assertWorktreeWritable(policy, worktree);
  assertStateRootIsolated(config.stateRoot, [...agentWritable, ...policy.readable]);
  assertSafeDir(config.stateRoot, config.accountHome);
  const instructions = spec.instructions ? buildProjectInstructions(spec.instructions, config.executables.git, agentWritable) : null;
  const home = assertPrivateDir(config.harnessHomes[spec.harness], config.stateRoot);
  const env = agentEnv(process.env, { harness: spec.harness, harnessHome: home, trustedPath: config.agentPath, accountHome: config.accountHome });
  const files = planRunFiles(config, spec.logDir, spec.runId, agentWritable);
  const instructionsPath = instructions === null ? null : files.instructionsPath;
  const args =
    spec.harness === "claude"
      ? claudeArgs({ prompt: spec.prompt, model: spec.model, effort: spec.effort, sessionId: spec.runId, policy, instructionsFile: instructionsPath })
      : codexArgs({ prompt: spec.prompt, model: spec.model, effort: spec.effort, worktreePath: worktree, policy, instructions });

  // Everything above only checks; from here the attempt id is used, and every step either spawns or undoes itself.
  const logs = reserveRunFiles(files, instructions);
  let proc: AgentProcess;
  try {
    proc = spawnAgentProcess({ executable, args, cwd: worktree, env, stdoutFd: logs.stdoutFd, stderrFd: logs.stderrFd, psPath: config.executables.ps });
  } finally {
    closeSync(logs.stdoutFd);
    closeSync(logs.stderrFd);
  }

  let monitor: RunMonitor | null = null;
  if (spec.monitor) {
    monitor = openRunMonitor({ orcaPath: config.executables.orca, worktreePath: worktree, title: `factory: ${spec.monitor.agent} ${spec.runId}`, attemptId: spec.runId, logPath: logs.stdoutPath });
  }

  const { status, stopped, cleanup, unverified } = await superviseRun(proc, { timeoutMs: spec.timeoutMs, signal: spec.signal, psPath: config.executables.ps });

  const diagnostics: string[] = [];
  // The monitor closes first: its tab is the owner's, not the run's, though the sweep would skip it anyway.
  if (monitor) diagnostics.push(...(await monitor.close()).map((d) => `monitor: ${d}`));
  if (status?.error) diagnostics.push(`spawn failed: ${status.error}`);
  // Anything still running in the worktree now outlived the run, wherever it sits in the process tree.
  const sweep = await sweepWorktree(worktree, { psPath: config.executables.ps, lsofPath: config.executables.lsof });
  const quarantineReasons = [...unverified];
  if (sweep.scanError) quarantineReasons.push(`worktree scan failed: ${sweep.scanError}`);
  if (sweep.found.length > 0) quarantineReasons.push(`${sweep.found.length} processes were still running in the worktree after the run: ${sweep.found.map((p) => p.pid).join(", ")}`);
  const sweepClean = !sweep.cleanup || (sweep.cleanup.survivors.length === 0 && sweep.cleanup.errors.length === 0);
  if (sweep.cleanup) {
    quarantineReasons.push(...sweep.cleanup.errors.map((e) => `worktree sweep: ${e}`));
    if (sweep.cleanup.survivors.length > 0) quarantineReasons.push(`worktree sweep could not kill: ${sweep.cleanup.survivors.map((p) => p.pid).join(", ")}`);
  }
  diagnostics.push(...quarantineReasons.map((r) => `quarantine: ${r}`));
  const outcome = (succeeded: boolean): RunOutcome => stopped ?? (status?.code === 0 && succeeded ? "completed" : "failed");
  const base = {
    harness: spec.harness,
    runId: spec.runId,
    exitCode: status?.code ?? null,
    signalCode: status?.signal ?? null,
    requestedModel: spec.model,
    stdoutPath: logs.stdoutPath,
    stderrPath: logs.stderrPath,
    instructionsPath,
    cleanup,
    noKnownSurvivors: unverified.length === 0 && sweep.scanError === null && sweepClean,
    quarantineWorktree: quarantineReasons.length > 0,
    quarantineReasons,
  };

  if (spec.harness === "claude") {
    const s = await parseClaudeStream(readJsonl(logs.stdoutPath));
    return {
      ...base,
      sessionId: s.sessionId,
      outcome: outcome(s.succeeded),
      observedModel: s.observedModel,
      usage: s.usage,
      resultText: s.resultText,
      diagnostics: [...diagnostics, ...s.diagnostics],
    };
  }
  const s = await parseCodexEvents(readJsonl(logs.stdoutPath));
  diagnostics.push(...s.diagnostics);
  return {
    ...base,
    sessionId: s.threadId,
    outcome: outcome(s.succeeded),
    observedModel: s.threadId ? await observedCodexModel(join(home, "sessions"), s.threadId, diagnostics) : null,
    usage: s.usage,
    resultText: s.resultText,
    diagnostics,
  };
}

/** The observed model is evidence, not the outcome: failures here only make it unknown. */
async function observedCodexModel(root: string, threadId: string, diagnostics: string[]): Promise<string | null> {
  try {
    const file = await findCodexSessionFile(root, threadId);
    if (!file) {
      diagnostics.push(`observed model unknown: no rollout for thread ${threadId}`);
      return null;
    }
    const model = await codexSessionModel(file);
    if (!model) diagnostics.push(`observed model unknown: no turn_context model in ${file}`);
    return model;
  } catch (err) {
    diagnostics.push(`observed model unknown: ${(err as Error).message}`);
    return null;
  }
}
