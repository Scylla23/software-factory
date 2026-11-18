import { join } from "node:path";
import { claudeCommand, parseClaudeStream } from "./claude";
import { codexCommand, codexSessionModel, findCodexSessionFile, parseCodexEvents } from "./codex";
import { agentEnv, DEFAULT_DENY_READ } from "./policy";
import { terminateTree } from "./process";
import type { RunOutcome, RunResult, RunSpec } from "./types";

export type { RunResult, RunSpec } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Runs one headless agent turn in a worktree and waits for it.
 * stdout is written straight to a log file so the raw stream survives a factory crash.
 */
export async function runAgent(spec: RunSpec): Promise<RunResult> {
  if (!UUID.test(spec.runId)) throw new Error(`runId must be a lowercase UUID: ${spec.runId}`);
  const denyRead = spec.denyRead ?? DEFAULT_DENY_READ;
  const cmd =
    spec.harness === "claude"
      ? claudeCommand({ prompt: spec.prompt, model: spec.model, effort: spec.effort, sessionId: spec.runId, denyRead })
      : codexCommand({ prompt: spec.prompt, model: spec.model, effort: spec.effort, worktreePath: spec.worktreePath, denyRead });
  const stdoutPath = join(spec.logDir, `${spec.runId}.stdout.jsonl`);
  const stderrPath = join(spec.logDir, `${spec.runId}.stderr.log`);

  const env = agentEnv(process.env);
  const proc = Bun.spawn(cmd, {
    cwd: spec.worktreePath,
    env,
    stdin: "ignore",
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  });

  let stopped: "cancelled" | "timed_out" | null = null;
  let termination: Promise<void> | null = null;
  const stop = (why: "cancelled" | "timed_out") => {
    if (stopped) return;
    stopped = why;
    termination = terminateTree(proc);
  };
  const timer = setTimeout(() => stop("timed_out"), spec.timeoutMs);
  const onAbort = () => stop("cancelled");
  if (spec.signal?.aborted) onAbort();
  spec.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
    spec.signal?.removeEventListener("abort", onAbort);
  }
  // The root can exit before its orphaned children are swept.
  await termination;

  const stdout = await Bun.file(stdoutPath).text();
  const exitCode = proc.exitCode;
  const outcome = (succeeded: boolean): RunOutcome => stopped ?? (exitCode === 0 && succeeded ? "completed" : "failed");
  const base = { harness: spec.harness, runId: spec.runId, exitCode, signalCode: proc.signalCode ?? null, requestedModel: spec.model, stdoutPath, stderrPath };

  if (spec.harness === "claude") {
    const s = parseClaudeStream(stdout);
    return { ...base, sessionId: s.sessionId, outcome: outcome(s.succeeded), observedModel: s.observedModel, usage: s.usage, resultText: s.resultText };
  }
  const s = parseCodexEvents(stdout);
  return {
    ...base,
    sessionId: s.threadId,
    outcome: outcome(s.succeeded),
    observedModel: s.threadId ? await observedCodexModel(join(env.HOME!, ".codex", "sessions"), s.threadId) : null,
    usage: s.usage,
    resultText: s.resultText,
  };
}

async function observedCodexModel(root: string, threadId: string): Promise<string | null> {
  const file = await findCodexSessionFile(root, threadId);
  return file ? codexSessionModel(await Bun.file(file).text()) : null;
}
