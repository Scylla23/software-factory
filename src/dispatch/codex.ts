import { Glob } from "bun";
import { describeInvalid, isRecord, type JsonlItem, readJsonl, str } from "./jsonl";
import { effectiveDenyRead } from "./policy";
import type { CodexUsage } from "./types";

const PROFILE = "factory";

/**
 * `-c` overrides for a workspace-write sandbox with a read deny-list and no network.
 * Do not add `-s workspace-write`: it silently replaces `default_permissions`, dropping the deny-list.
 */
export function codexConfigArgs(extraDenyRead: readonly string[] = []): string[] {
  // JSON string literals are valid TOML basic strings.
  const filesystem = effectiveDenyRead(extraDenyRead).map((p) => `${JSON.stringify(p)}="none"`).join(",");
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
  extraDenyRead?: readonly string[];
}

/** Arguments after the executable, which the caller resolves (config.ts). */
export function codexArgs(input: CodexCommandInput): string[] {
  return [
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "-m", input.model,
    "-c", `model_reasoning_effort=${JSON.stringify(input.effort)}`,
    ...codexConfigArgs(input.extraDenyRead),
    "-C", input.worktreePath,
    "--",
    input.prompt,
  ];
}

export interface CodexStreamSummary {
  threadId: string | null;
  /** True when a turn completed and the stream is intact with no turn or stream error. */
  succeeded: boolean;
  resultText: string | null;
  /** Null when any turn's accounting is missing, malformed, or may have been lost; never partial. */
  usage: CodexUsage | null;
  diagnostics: string[];
}

/**
 * Parses `codex exec --json` JSONL.
 * Usage is the sum over `turn.completed` events, so it is only trusted when every line parsed:
 * a corrupt or truncated line may have been a `turn.completed` or a `turn.failed`.
 */
export async function parseCodexEvents(items: AsyncIterable<JsonlItem>): Promise<CodexStreamSummary> {
  const diagnostics: string[] = [];
  let threadId: string | null = null;
  let resultText: string | null = null;
  let usage: CodexUsage | null = null;
  let accountingComplete = true;
  let completed = false;
  let failed = false;
  for await (const item of items) {
    if (item.kind === "invalid") {
      diagnostics.push(describeInvalid(item));
      accountingComplete = false;
      continue;
    }
    const event = item.value;
    if (event.type === "thread.started") {
      threadId = str(event.thread_id);
    } else if (event.type === "item.completed" && isRecord(event.item) && event.item.type === "agent_message") {
      resultText = str(event.item.text) ?? resultText;
    } else if (event.type === "turn.completed") {
      completed = true;
      const turn = codexTurnUsage(event.usage);
      if (!turn) {
        diagnostics.push(`line ${item.line}: turn.completed has malformed usage`);
        accountingComplete = false;
      } else {
        usage = usage ? addUsage(usage, turn) : turn;
      }
    } else if (event.type === "turn.failed" || event.type === "error") {
      failed = true;
    }
  }
  if (!accountingComplete) usage = null;
  return { threadId, succeeded: completed && !failed && accountingComplete, resultText, usage, diagnostics };
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
  if (!THREAD_ID.test(threadId)) throw new Error(`not a Codex thread id: ${JSON.stringify(threadId.slice(0, 80))}`);
  const glob = new Glob(`*/*/*/rollout-*-${threadId}.jsonl`);
  for await (const rel of glob.scan({ cwd: sessionsRoot, onlyFiles: true })) return `${sessionsRoot}/${rel}`;
  return null;
}

/** The model of the last `turn_context` record, which is what Codex actually ran. */
export async function codexSessionModel(sessionFile: string): Promise<string | null> {
  let model: string | null = null;
  // Rollouts hold large records (instructions, tool output); only turn_context matters and it is small.
  for await (const item of readJsonl(sessionFile)) {
    if (item.kind === "record" && item.value.type === "turn_context" && isRecord(item.value.payload)) {
      model = str(item.value.payload.model) ?? model;
    }
  }
  return model;
}
