import { closeSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeArgs, parseClaudeStream } from "./claude";
import { codexArgs, codexSessionModel, findCodexSessionFile, parseCodexEvents } from "./codex";
import { assertPrivateDir, createRunLogs, type DispatchConfig, isUnder, managedSettingsProblems, tempRoots, writeRunFile } from "./config";
import { buildProjectInstructions } from "./instructions";
import { readJsonl } from "./jsonl";
import { openRunMonitor, type RunMonitor } from "../orca/monitor";
import { agentEnv } from "./policy";
import { type AgentProcess, spawnAgentProcess, type TerminationReport, terminateTree } from "./process";
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
  const instructions = buildProjectInstructions(spec.instructionFiles, agentWritable);
  const home = assertPrivateDir(config.harnessHomes[spec.harness], config.stateRoot);
  const env = agentEnv(process.env, spec.harness, home, config.agentPath);
  const logs = createRunLogs(config, spec.logDir, spec.runId, agentWritable);
  let instructionsPath: string | null = null;
  try {
    if (instructions !== null) {
      instructionsPath = join(dirname(logs.stdoutPath), `${spec.runId}.instructions.md`);
      writeRunFile(instructionsPath, instructions);
    }
  } catch (err) {
    closeSync(logs.stdoutFd);
    closeSync(logs.stderrFd);
    throw err;
  }
  const args =
    spec.harness === "claude"
      ? claudeArgs({ prompt: spec.prompt, model: spec.model, effort: spec.effort, sessionId: spec.runId, extraDenyRead: spec.extraDenyRead, instructionsFile: instructionsPath })
      : codexArgs({ prompt: spec.prompt, model: spec.model, effort: spec.effort, worktreePath: worktree, extraDenyRead: spec.extraDenyRead, instructions });

  let proc: AgentProcess;
  try {
    proc = spawnAgentProcess({ executable, args, cwd: worktree, env, stdoutFd: logs.stdoutFd, stderrFd: logs.stderrFd, psPath: config.executables.ps });
  } finally {
    closeSync(logs.stdoutFd);
    closeSync(logs.stderrFd);
  }

  let monitor: RunMonitor | null = null;
  if (spec.monitor) {
    monitor = openRunMonitor({ orcaPath: config.executables.orca, worktreePath: worktree, title: `factory: ${spec.monitor.agent} ${spec.runId}`, logPath: logs.stdoutPath });
  }

  let stopped: "cancelled" | "timed_out" | null = null;
  let termination: Promise<TerminationReport> | null = null;
  const stop = (why: "cancelled" | "timed_out") => {
    if (stopped) return;
    stopped = why;
    termination = terminateTree(proc, { psPath: config.executables.ps });
  };
  const timer = setTimeout(() => stop("timed_out"), spec.timeoutMs);
  const onAbort = () => stop("cancelled");
  spec.signal?.addEventListener("abort", onAbort, { once: true });
  let status;
  try {
    status = await proc.exited;
  } finally {
    clearTimeout(timer);
    spec.signal?.removeEventListener("abort", onAbort);
  }
  // The root can exit before its orphaned children are swept.
  const cleanup: TerminationReport | null = termination ? await (termination as Promise<TerminationReport>) : null;

  const diagnostics: string[] = [];
  if (monitor) diagnostics.push(...(await monitor.close()).map((d) => `monitor: ${d}`));
  if (status.error) diagnostics.push(`spawn failed: ${status.error}`);
  if (cleanup) {
    diagnostics.push(...cleanup.errors.map((e) => `cleanup: ${e}`));
    if (cleanup.survivors.length > 0) diagnostics.push(`cleanup: ${cleanup.survivors.length} owned processes survived`);
  }
  const outcome = (succeeded: boolean): RunOutcome => stopped ?? (status.code === 0 && succeeded ? "completed" : "failed");
  const base = {
    harness: spec.harness,
    runId: spec.runId,
    exitCode: status.code,
    signalCode: status.signal,
    requestedModel: spec.model,
    stdoutPath: logs.stdoutPath,
    stderrPath: logs.stderrPath,
    instructionsPath,
    cleanup,
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
