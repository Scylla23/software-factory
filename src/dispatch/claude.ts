import { isRecord, jsonLines, str } from "./json";
import { assertDenyPath } from "./policy";
import type { ClaudeModelUsage, ClaudeUsage } from "./types";

/** Built-in tools a builder may use; nothing that reaches the network. */
export const CLAUDE_BUILDER_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;

/**
 * Settings passed with `--settings`.
 * `--restricted` ignores user, project, and local settings, so this is the whole policy.
 */
export function claudeSettings(denyRead: readonly string[]): object {
  for (const p of denyRead) assertDenyPath(p);
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
      filesystem: { denyRead: [...denyRead] },
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
  denyRead: readonly string[];
}

export function claudeCommand(input: ClaudeCommandInput): string[] {
  return [
    "claude",
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", input.model,
    "--effort", input.effort,
    "--session-id", input.sessionId,
    "--restricted",
    "--tools", CLAUDE_BUILDER_TOOLS.join(","),
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--settings", JSON.stringify(claudeSettings(input.denyRead)),
    "--",
    input.prompt,
  ];
}

export interface ClaudeStreamSummary {
  sessionId: string | null;
  /** Main-loop model from the `system/init` event. */
  observedModel: string | null;
  /** True only when a `result` event reports success. */
  succeeded: boolean;
  resultText: string | null;
  usage: ClaudeUsage | null;
}

/** Parses `--output-format stream-json` output; tolerates a truncated stream from a killed run. */
export function parseClaudeStream(stdout: string): ClaudeStreamSummary {
  const summary: ClaudeStreamSummary = { sessionId: null, observedModel: null, succeeded: false, resultText: null, usage: null };
  for (const event of jsonLines(stdout)) {
    if (event.type === "system" && event.subtype === "init") {
      summary.sessionId = str(event.session_id) ?? summary.sessionId;
      summary.observedModel = str(event.model);
    } else if (event.type === "result") {
      summary.sessionId = str(event.session_id) ?? summary.sessionId;
      summary.succeeded = event.subtype === "success" && event.is_error === false;
      summary.resultText = str(event.result);
      summary.usage = claudeUsage(event);
    }
  }
  return summary;
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
