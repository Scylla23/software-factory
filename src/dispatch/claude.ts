import { describeInvalid, isRecord, type JsonlItem, str } from "./jsonl";
import { effectiveDenyRead } from "./policy";
import type { ClaudeModelUsage, ClaudeUsage } from "./types";

/** Built-in tools a builder may use; nothing that reaches the network. */
export const CLAUDE_BUILDER_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;

/**
 * Settings passed with `--settings`.
 * `--restricted` ignores user, project, and local settings, so this plus managed settings is the whole policy;
 * runAgent refuses to dispatch when unaccepted managed settings exist (see config.ts).
 */
export function claudeSettings(extraDenyRead: readonly string[] = []): object {
  const denyRead = effectiveDenyRead(extraDenyRead);
  return {
    permissions: {
      allow: [...CLAUDE_BUILDER_TOOLS],
      deny: ["WebFetch", "WebSearch", ...denyRead.flatMap((p) => [`Read(${rulePath(p)})`, `Read(${rulePath(p)}/**)`])],
      blockReadsOutsideWorkingDirectories: true,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [] },
      filesystem: { denyRead },
    },
  };
}

/** Permission rules spell absolute paths with a leading `//`. */
function rulePath(p: string): string {
  return p.startsWith("/") ? `/${p}` : p;
}

export interface ClaudeCommandInput {
  prompt: string;
  model: string;
  effort: string;
  sessionId: string;
  extraDenyRead?: readonly string[];
}

/** Arguments after the executable, which the caller resolves (config.ts). */
export function claudeArgs(input: ClaudeCommandInput): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", input.model,
    "--effort", input.effort,
    "--session-id", input.sessionId,
    "--restricted",
    "--tools", CLAUDE_BUILDER_TOOLS.join(","),
    "--strict-mcp-config",
    // No skills or slash commands at all; the dedicated CLAUDE_CONFIG_DIR already drops the owner's, this drops the built-ins.
    "--disable-slash-commands",
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--settings", JSON.stringify(claudeSettings(input.extraDenyRead)),
    "--",
    input.prompt,
  ];
}

export interface ClaudeStreamSummary {
  sessionId: string | null;
  /** Main-loop model from the `system/init` event. */
  observedModel: string | null;
  /** True only when exactly one `result` event reports success. */
  succeeded: boolean;
  resultText: string | null;
  /** Null when absent, malformed, or ambiguous; never zero-filled. */
  usage: ClaudeUsage | null;
  diagnostics: string[];
}

/**
 * Parses `--output-format stream-json` output.
 * The `result` event carries the run's whole accounting, so a lost interior line does not make usage incomplete,
 * but a second `result` event does, because it is unclear whether its totals are cumulative.
 */
export async function parseClaudeStream(items: AsyncIterable<JsonlItem>): Promise<ClaudeStreamSummary> {
  const s: ClaudeStreamSummary = { sessionId: null, observedModel: null, succeeded: false, resultText: null, usage: null, diagnostics: [] };
  let results = 0;
  for await (const item of items) {
    if (item.kind === "invalid") {
      s.diagnostics.push(describeInvalid(item));
      continue;
    }
    const event = item.value;
    if (event.type === "system" && event.subtype === "init") {
      s.sessionId = str(event.session_id) ?? s.sessionId;
      s.observedModel = str(event.model);
    } else if (event.type === "result") {
      results++;
      s.sessionId = str(event.session_id) ?? s.sessionId;
      s.succeeded = event.subtype === "success" && event.is_error === false;
      s.resultText = str(event.result);
      s.usage = claudeUsage(event);
      if (!s.usage) s.diagnostics.push(`line ${item.line}: result event has malformed usage`);
    }
  }
  if (results > 1) {
    s.diagnostics.push(`${results} result events; accounting is ambiguous`);
    s.succeeded = false;
    s.usage = null;
  }
  return s;
}

function claudeUsage(result: Record<string, unknown>): ClaudeUsage | null {
  const modelUsage = result.modelUsage;
  if (typeof result.total_cost_usd !== "number" || !isRecord(modelUsage)) return null;
  const byModel: Record<string, ClaudeModelUsage> = {};
  for (const [model, raw] of Object.entries(modelUsage)) {
    if (!isRecord(raw)) return null;
    const u = {
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      cacheReadInputTokens: raw.cacheReadInputTokens,
      cacheCreationInputTokens: raw.cacheCreationInputTokens,
      costUsd: raw.costUSD,
    };
    if (!Object.values(u).every((v) => typeof v === "number")) return null;
    byModel[model] = u as ClaudeModelUsage;
  }
  return { harness: "claude", totalCostUsd: result.total_cost_usd, byModel };
}
