import { Glob } from "bun";
import { describeInvalid, DiagnosticSample, isRecord, type JsonlItem, readJsonl, str } from "./jsonl";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { isUnder } from "./config";
import type { SandboxPolicy } from "./policy";
import type { CodexUsage } from "./types";

const PROFILE = "factory";

/**
 * Read access carved back out of a denied tree, the more specific entry winning in Codex's profile.
 * Codex's sandbox helper re-execs the Codex binary, so the verified executable's own directory must stay readable
 * when it lies under a denied path (it is installed under the denied ~/.codex); nothing wider is reopened.
 */
export function codexReadable(codexExecutable: string, denyRead: readonly string[]): string[] {
  const dir = dirname(realpathSync(codexExecutable));
  return denyRead.some((d) => isUnder(dir, d)) ? [dir] : [];
}

/**
 * A TOML basic string. JSON escapes are valid TOML except that TOML also forbids a raw DEL;
 * lone surrogates cannot occur because every input is a well-formed string (UTF-8 is decoded strictly).
 */
export function tomlString(s: string): string {
  return JSON.stringify(s).replaceAll("\x7f", "\\u007f");
}

/**
 * `-c` overrides for a workspace-write sandbox with a read deny-list and no network.
 * Do not add `-s workspace-write`: it silently replaces `default_permissions`, dropping the deny-list.
 */
export function codexConfigArgs(policy: SandboxPolicy): string[] {
  for (const p of policy.readable) {
    // A duplicate key is a TOML error, and the intent (deny or read) would be ambiguous anyway.
    if (policy.denyRead.includes(p)) throw new Error(`cannot deny ${p}: Codex needs it readable to run`);
  }
  // A write-denied path that is also read-denied stays "none"; anything else would be a duplicate key.
  const readOnly = [...policy.readable, ...policy.denyWrite.filter((p) => !policy.denyRead.includes(p) && !policy.readable.includes(p))];
  const filesystem = [
    ...policy.denyRead.map((p) => `${tomlString(p)}="none"`),
    ...readOnly.map((p) => `${tomlString(p)}="read"`),
  ].join(",");
  return [
    "-c", `permissions={${PROFILE}={extends=":workspace", filesystem={${filesystem}}}}`,
    "-c", `default_permissions="${PROFILE}"`,
    "-c", `shell_environment_policy.inherit="core"`,
    "-c", "allow_login_shell=false",
    ...CODEX_HERMETIC_CONFIG.flatMap((kv) => ["-c", kv]),
  ];
}

/**
 * What a dedicated CODEX_HOME does not remove on its own, verified per flag against the session rollout.
 * Without these a run still gets the owner's `~/.agents/skills`, the account's remote plugins and apps,
 * and the hosted `web__run` tool, which the sandbox's network block does not cover.
 */
export const CODEX_HERMETIC_CONFIG: readonly string[] = [
  `web_search="disabled"`,
  // No skill listing at all: the owner's ~/.agents/skills, plugin skills, and the bundled system skills.
  "skills.include_instructions=false",
  "skills.bundled.enabled=false",
  "features.plugins=false",
  "features.remote_plugin=false",
  "features.apps=false",
  "features.hooks=false",
  "features.image_generation=false",
];

export interface CodexCommandInput {
  prompt: string;
  model: string;
  effort: string;
  worktreePath: string;
  policy: SandboxPolicy;
  /** Project instructions, given verbatim as developer instructions; Codex's own AGENTS.md discovery is always off. */
  instructions?: string | null;
}

/** Arguments after the executable, which the caller resolves (config.ts). */
export function codexArgs(input: CodexCommandInput): string[] {
  return [
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "-m", input.model,
    "-c", `model_reasoning_effort=${tomlString(input.effort)}`,
    ...codexConfigArgs(input.policy),
    // Codex would otherwise load AGENTS.md from the agent-writable worktree on its own, next to the explicit copy.
    "-c", "project_doc_max_bytes=0",
    ...(input.instructions ? ["-c", `developer_instructions=${tomlString(input.instructions)}`] : []),
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
  /** A bounded sample; `diagnosticCount` counts them all. */
  diagnostics: string[];
  diagnosticCount: number;
}

/**
 * Parses `codex exec --json` JSONL.
 * Usage is the sum over `turn.completed` events, so it is only trusted when every line parsed:
 * a corrupt or truncated line may have been a `turn.completed` or a `turn.failed`.
 */
export async function parseCodexEvents(items: AsyncIterable<JsonlItem>): Promise<CodexStreamSummary> {
  const sample = new DiagnosticSample();
  let threadId: string | null = null;
  let resultText: string | null = null;
  let usage: CodexUsage | null = null;
  let accountingComplete = true;
  let completed = false;
  let failed = false;
  for await (const item of items) {
    if (item.kind === "invalid") {
      sample.add(describeInvalid(item));
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
        sample.add(`line ${item.line}: turn.completed has malformed usage`);
        accountingComplete = false;
      } else {
        usage = usage ? addUsage(usage, turn) : turn;
      }
    } else if (event.type === "turn.failed" || event.type === "error") {
      failed = true;
    }
  }
  if (!accountingComplete) usage = null;
  return { threadId, succeeded: completed && !failed && accountingComplete, resultText, usage, diagnostics: sample.list(), diagnosticCount: sample.count };
}

export function codexTurnUsage(raw: unknown): CodexUsage | null {
  if (!isRecord(raw)) return null;
  const u = {
    inputTokens: raw.input_tokens,
    cachedInputTokens: raw.cached_input_tokens,
    cacheWriteInputTokens: raw.cache_write_input_tokens ?? 0,
    outputTokens: raw.output_tokens,
    reasoningOutputTokens: raw.reasoning_output_tokens ?? 0,
  };
  if (!Object.values(u).every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return null;
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
  if (!lstatSync(sessionsRoot, { throwIfNoEntry: false })?.isDirectory() || realpathSync(sessionsRoot) !== sessionsRoot) return null;
  let found: string | null = null;
  for await (const rel of glob.scan({ cwd: sessionsRoot, onlyFiles: true, followSymlinks: false })) {
    const path = `${sessionsRoot}/${rel}`;
    const st = lstatSync(path);
    if (found || !st.isFile() || st.nlink !== 1 || realpathSync(path) !== path) return null;
    found = path;
  }
  return found;
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
