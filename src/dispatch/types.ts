import type { InstructionSource } from "./instructions";
import type { TerminationReport } from "./process";

export type Harness = "claude" | "codex";

export interface RunSpec {
  harness: Harness;
  /** Absolute path of the Orca-created worktree the agent works in. */
  worktreePath: string;
  prompt: string;
  model: string;
  effort: string;
  /** Existing directory under the state root that receives `<runId>.stdout.jsonl` and `<runId>.stderr.log`. */
  logDir: string;
  /** Unique per attempt and single-use; also the Claude session id, so it must be a lowercase UUID. */
  runId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * The project's instruction files (usually AGENTS.md and CLAUDE.md), passed to the harness explicitly and
   * identically, or null for none. Read before spawn as tracked blobs at the approved base commit, never from a
   * working tree (see `buildProjectInstructions`).
   */
  instructions: InstructionSource | null;
  /** Paths denied in addition to MANDATORY_DENY_READ, which always applies. */
  extraDenyRead?: readonly string[];
  /**
   * Opens a read-only Orca terminal titled `factory: <agent> <runId>` that tails the stdout log, closed when the run ends.
   * Best effort: its failures only add `monitor:` diagnostics.
   */
  monitor?: { agent: string };
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
  /** The exact project instructions the run received, kept with the logs; null when there were none. */
  instructionsPath: string | null;
  /** Why a field is unknown or the stream was imperfect: corrupt lines, a missing rollout, a spawn error. */
  diagnostics: string[];
  /** Set when the run was cancelled or timed out; survivors are owned processes that could not be killed. */
  cleanup: TerminationReport | null;
}
