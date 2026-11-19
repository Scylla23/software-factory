import { count, money } from "./validation";
import { describeInvalid, DiagnosticSample, isRecord, type JsonlItem, str } from "./jsonl";
import type { SandboxPolicy } from "./policy";
import type { ClaudeModelUsage, ClaudeUsage } from "./types";

/** Built-in tools a builder may use; nothing that reaches the network. */
export const CLAUDE_BUILDER_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;

/**
 * Settings passed with `--settings`.
 * `--restricted` ignores user, project, and local settings, so this plus managed settings is the whole policy;
 * runAgent refuses to dispatch while any managed settings source exists (see config.ts).
 * Claude has no read carve-outs: `policy.readable` is for Codex's own binary.
 */
export function claudeSettings(policy: SandboxPolicy): object {
  const denyRead = [...policy.denyRead];
  const denyWrite = [...policy.denyWrite];
  const rules = (tool: string, p: string) => [`${tool}(${rulePath(p)})`, `${tool}(${rulePath(p)}/**)`];
  return {
    permissions: {
      allow: [...CLAUDE_BUILDER_TOOLS],
      deny: [
        "WebFetch",
        "WebSearch",
        ...denyRead.flatMap((p) => rules("Read", p)),
        ...denyWrite.flatMap((p) => [...rules("Edit", p), ...rules("Write", p)]),
      ],
      blockReadsOutsideWorkingDirectories: true,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [] },
      // Claude's sandbox makes a linked worktree's shared git dir writable for Bash; denyWrite takes it back.
      filesystem: { denyRead, denyWrite },
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
  policy: SandboxPolicy;
  /**
   * File holding the project instructions, appended to the system prompt.
   * `--restricted` already stops Claude from loading the worktree's CLAUDE.md on its own.
   */
  instructionsFile?: string | null;
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
    "--settings", JSON.stringify(claudeSettings(input.policy)),
    ...(input.instructionsFile ? ["--append-system-prompt-file", input.instructionsFile] : []),
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
  /** A bounded sample; `diagnosticCount` counts them all. */
  /** A valid result total can survive an unreadable token breakdown. */
  reportedCostUsd?: number;
  diagnostics: string[];
  diagnosticCount: number;
}

/**
 * Parses `--output-format stream-json` output.
 * The `result` event carries the run's whole accounting, so a lost interior line does not make usage incomplete,
 * but a second `result` event does, because it is unclear whether its totals are cumulative.
 */
export async function parseClaudeStream(items: AsyncIterable<JsonlItem>): Promise<ClaudeStreamSummary> {
  const s: ClaudeStreamSummary = { sessionId: null, observedModel: null, succeeded: false, resultText: null, usage: null, diagnostics: [], diagnosticCount: 0 };
  const sample = new DiagnosticSample();
  let results = 0;
  for await (const item of items) {
    if (item.kind === "invalid") {
      sample.add(describeInvalid(item));
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
      const total = usd(event.total_cost_usd);
      if (!s.usage && total !== null) s.reportedCostUsd = total;
      if (!s.usage) sample.add(`line ${item.line}: result event has malformed usage`);
    }
  }
  if (results > 1) {
    sample.add(`${results} result events; accounting is ambiguous`);
    s.succeeded = false;
    s.usage = null;
    delete s.reportedCostUsd;
  }
  s.diagnostics = sample.list();
  s.diagnosticCount = sample.count;
  return s;
}

function claudeUsage(result: Record<string, unknown>): ClaudeUsage | null {
  const modelUsage = result.modelUsage;
  if (!isRecord(modelUsage)) return null;
  const byModel: Record<string, ClaudeModelUsage> = Object.create(null);
  for (const [model, raw] of Object.entries(modelUsage)) {
    if (!isRecord(raw)) return null;
    const u = {
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      cacheReadInputTokens: raw.cacheReadInputTokens,
      cacheCreationInputTokens: raw.cacheCreationInputTokens,
    };
    if (!Object.values(u).every(count)) return null;
    byModel[model] = { ...u, costUsd: usd(raw.costUSD) } as ClaudeModelUsage;
  }
  return { harness: "claude", totalCostUsd: usd(result.total_cost_usd), byModel };
}

function usd(value: unknown): number | null {
  return money(value) ? value : null;
}
