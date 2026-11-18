export type Harness = "claude" | "codex";

export interface RunSpec {
  harness: Harness;
  /** Absolute path of the Orca-created worktree the agent works in. */
  worktreePath: string;
  prompt: string;
  model: string;
  effort: string;
  /** Existing directory that receives `<runId>.stdout.jsonl` and `<runId>.stderr.log`. */
  logDir: string;
  /** Unique per attempt; also the Claude session id, so it must be a UUID. */
  runId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Paths the agent must never read. Defaults to DEFAULT_DENY_READ. */
  denyRead?: readonly string[];
}

export type RunOutcome = "completed" | "failed" | "cancelled" | "timed_out";

export interface ClaudeModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

export interface ClaudeUsage {
  harness: "claude";
  /** Claude's own API-equivalent estimate. */
  totalCostUsd: number;
  byModel: Record<string, ClaudeModelUsage>;
}

/** Summed over every `turn.completed` event. `inputTokens` includes cached input, as Codex reports it. */
export interface CodexUsage {
  harness: "codex";
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface RunResult {
  harness: Harness;
  runId: string;
  /** Claude session id or Codex thread id, as reported by the CLI. */
  sessionId: string | null;
  /** Null when the process was killed by a signal; see `signalCode`. */
  exitCode: number | null;
  signalCode: string | null;
  outcome: RunOutcome;
  requestedModel: string;
  /** The model the harness actually ran, or null when it could not be established. */
  observedModel: string | null;
  /** Null when usage is unrecoverable; never zero-filled. */
  usage: ClaudeUsage | CodexUsage | null;
  /** Final agent message. */
  resultText: string | null;
  stdoutPath: string;
  stderrPath: string;
}
