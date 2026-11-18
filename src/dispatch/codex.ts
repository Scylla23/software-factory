import { Glob } from "bun";
import { isRecord, jsonLines, str } from "./json";
import { assertDenyPath } from "./policy";
import type { CodexUsage } from "./types";

const PROFILE = "factory";

/**
 * `-c` overrides for a workspace-write sandbox with a read deny-list and no network.
 * Do not add `-s workspace-write`: it silently replaces `default_permissions`, dropping the deny-list.
 */
export function codexConfigArgs(denyRead: readonly string[]): string[] {
  for (const p of denyRead) assertDenyPath(p);
  // JSON string literals are valid TOML basic strings.
  const filesystem = denyRead.map((p) => `${JSON.stringify(p)}="none"`).join(",");
  return [
    "-c", `permissions={${PROFILE}={extends=":workspace", filesystem={${filesystem}}}}`,
    "-c", `default_permissions="${PROFILE}"`,
    "-c", `shell_environment_policy.inherit="core"`,
    "-c", "allow_login_shell=false",
  ];
}

export interface CodexCommandInput {
  prompt: string;
  model: string;
  effort: string;
  worktreePath: string;
  denyRead: readonly string[];
}

export function codexCommand(input: CodexCommandInput): string[] {
  return [
    "codex", "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "-m", input.model,
    "-c", `model_reasoning_effort=${JSON.stringify(input.effort)}`,
    ...codexConfigArgs(input.denyRead),
    "-C", input.worktreePath,
    "--",
    input.prompt,
  ];
}

export interface CodexStreamSummary {
  threadId: string | null;
  /** True when a turn completed and no turn or stream error was reported. */
  succeeded: boolean;
  resultText: string | null;
  usage: CodexUsage | null;
}

/** Parses `codex exec --json` JSONL; tolerates a truncated stream from a killed run. */
export function parseCodexEvents(stdout: string): CodexStreamSummary {
  let threadId: string | null = null;
  let resultText: string | null = null;
  let usage: CodexUsage | null = null;
  let completed = false;
  let failed = false;
  for (const event of jsonLines(stdout)) {
    if (event.type === "thread.started") {
      threadId = str(event.thread_id);
    } else if (event.type === "item.completed" && isRecord(event.item) && event.item.type === "agent_message") {
      resultText = str(event.item.text) ?? resultText;
    } else if (event.type === "turn.completed") {
      completed = true;
      const turn = codexTurnUsage(event.usage);
      usage = turn && (usage ? addUsage(usage, turn) : turn);
    } else if (event.type === "turn.failed" || event.type === "error") {
      failed = true;
    }
  }
  return { threadId, succeeded: completed && !failed, resultText, usage };
}

function codexTurnUsage(raw: unknown): CodexUsage | null {
  if (!isRecord(raw)) return null;
  const u = {
    inputTokens: raw.input_tokens,
    cachedInputTokens: raw.cached_input_tokens,
    cacheWriteInputTokens: raw.cache_write_input_tokens ?? 0,
    outputTokens: raw.output_tokens,
    reasoningOutputTokens: raw.reasoning_output_tokens ?? 0,
  };
  if (!Object.values(u).every((v) => typeof v === "number")) return null;
  return { harness: "codex", ...(u as Omit<CodexUsage, "harness">) };
}

function addUsage(a: CodexUsage, b: CodexUsage): CodexUsage {
  return {
    harness: "codex",
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Finds `<sessionsRoot>/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl`. */
export async function findCodexSessionFile(sessionsRoot: string, threadId: string): Promise<string | null> {
  if (!THREAD_ID.test(threadId)) throw new Error(`not a Codex thread id: ${threadId}`);
  const glob = new Glob(`*/*/*/rollout-*-${threadId}.jsonl`);
  for await (const rel of glob.scan({ cwd: sessionsRoot, onlyFiles: true })) return `${sessionsRoot}/${rel}`;
  return null;
}

/** The model of the last `turn_context` record, which is what Codex actually ran. */
export function codexSessionModel(sessionJsonl: string): string | null {
  let model: string | null = null;
  for (const record of jsonLines(sessionJsonl)) {
    if (record.type === "turn_context" && isRecord(record.payload)) model = str(record.payload.model) ?? model;
  }
  return model;
}
