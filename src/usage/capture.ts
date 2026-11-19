import { isRecord } from "../dispatch/jsonl";
import type { RunResult } from "../dispatch/types";
import { estimate, priceDate, type Tokens } from "./prices";

export interface Line extends Tokens {
  model: string | null;
  costUsd: number | null;
}
export interface Capture {
  source: "result" | "session" | "unknown";
  coverage: "complete" | "partial" | "unknown";
  lines: Line[];
  costUsd: number | null;
  reportedTotal: boolean;
  priceDate: string;
}

export function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function money(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
export function codexLine(model: string | null, raw: Record<string, unknown>, perRequest: boolean): Line | null {
  const { inputTokens: input, cachedInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite,
    outputTokens: output, reasoningOutputTokens: reasoning } = raw;
  if (!count(input) || !count(cacheRead) || !count(cacheWrite) || !count(output) || !count(reasoning)
      || cacheRead + cacheWrite > input || reasoning > output) return null;
  const t = { input: input - cacheRead - cacheWrite, cacheRead, cacheWrite, output, reasoning };
  return { model, ...t, costUsd: estimate(model, t, 0, perRequest) };
}

export function summarize(lines: Line[], source: Capture["source"], complete: boolean, total?: number | null): Capture {
  const costUsd = total ?? (lines.length && lines.every(l => l.costUsd !== null)
    ? lines.reduce((n, l) => n + l.costUsd!, 0) : null);
  return { source, coverage: lines.length ? (complete ? "complete" : "partial") : "unknown", lines, costUsd, reportedTotal: total != null, priceDate };
}

export function primary(usage: unknown, model: string | null, outcome: string): Capture {
  const lines: Line[] = [];
  if (isRecord(usage) && usage.harness === "codex") {
    const line = codexLine(model, usage, false);
    if (line) return summarize([line], "result", outcome === "completed");
  }
  if (isRecord(usage) && usage.harness === "claude" && isRecord(usage.byModel)) {
    const entries = Object.entries(usage.byModel);
    for (const [model, u] of entries) {
      if (!isRecord(u) || !model || !count(u.inputTokens) || !count(u.cacheReadInputTokens)
          || !count(u.cacheCreationInputTokens) || !count(u.outputTokens)) continue;
      const t = { input: u.inputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens,
        output: u.outputTokens, reasoning: null };
      lines.push({ model, ...t, costUsd: money(u.costUsd) ? u.costUsd : estimate(model, t) });
    }
    const total = money(usage.totalCostUsd) ? usage.totalCostUsd : null;
    if (lines.length || total !== null) return summarize(lines, "result", lines.length === entries.length, total);
  }
  return summarize([], "unknown", false);
}

export type RunUsage = Pick<RunResult, "harness" | "runId" | "sessionId" | "requestedModel" | "observedModel" | "usage" | "reportedCostUsd"> & { outcome: RunResult["outcome"] | "uncertain" };
