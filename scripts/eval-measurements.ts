import type { DispatchConfig } from "../src/dispatch/config";
import { parseCodexEvents } from "../src/dispatch/codex";
import { isDeepStrictEqual } from "node:util";
import { parseClaudeStream } from "../src/dispatch/claude";
import { sessionUuid } from "../src/dispatch/validation";
import { isRecord, type JsonlItem, readJsonl } from "../src/dispatch/jsonl";
import type { Capture } from "../src/usage/capture";
import { captureRun } from "../src/usage/sessions";

export type Meter = { fresh: number; read: number; write: number | null; output: number; cost: number | null };
export function sums(capture: Capture): Meter {
  if (!capture.lines.length) throw new Error("no measured usage");
  const add = (f: (line: Capture["lines"][number]) => number) => capture.lines.reduce((n, l) => n + f(l), 0);
  return {
    fresh: add((l) => l.input),
    read: add((l) => l.cacheRead),
    write: capture.lines.every((l) => l.cacheWrite !== null) ? add((l) => l.cacheWrite!) : null,
    output: add((l) => l.output),
    cost: capture.costUsd,
  };
}
export async function codexMeter(dispatch: DispatchConfig, file: string, session: string, model: string) {
  const parsed = await parseCodexEvents(readJsonl(file));
  if (parsed.threadId !== session || !parsed.usage || !parsed.succeeded) throw new Error("cannot join Codex usage to its session");
  const { capture, observed } = await captureRun(
    { harness: "codex", runId: session, sessionId: session, requestedModel: model, observedModel: null, usage: null, outcome: "completed" },
    dispatch,
  );
  const m = sums(capture);
  if (
    observed !== model ||
    m.write === null ||
    m.fresh + m.read + m.write !== parsed.usage.inputTokens ||
    m.read !== parsed.usage.cachedInputTokens ||
    m.output !== parsed.usage.outputTokens
  )
    throw new Error("Codex public and per-request usage disagree");
  return m;
}

// Task notifications can repeat the same final charge. Reconcile only that charge.
// The dispatcher's single-result completion check still rejects the attempt.
export async function repeatedTeamCharge(items: AsyncIterable<JsonlItem>, session: string, model: string) {
  let first: Extract<JsonlItem, { kind: "record" }> | undefined;
  let index = 0,
    init = 0;
  const ids = new Set<string>();
  for await (const item of items) {
    if (item.kind !== "record") return null;
    const e = item.value;
    if (e.type === "system" && e.subtype === "init") {
      if (e.model !== model || e.session_id !== session) return null;
      init++;
    }
    if (e.type !== "result") continue;
    if (
      !init ||
      e.session_id !== session ||
      e.result_index !== index++ ||
      typeof e.uuid !== "string" ||
      !sessionUuid.test(e.uuid) ||
      ids.has(e.uuid) ||
      !isRecord(e.modelUsage) ||
      !Object.keys(e.modelUsage).length ||
      typeof e.total_cost_usd !== "number" ||
      !Number.isFinite(e.total_cost_usd) ||
      e.total_cost_usd < 0
    )
      return null;
    ids.add(e.uuid);
    if (!first) {
      if (e.origin != null || !isDeepStrictEqual(e.model_usage_since_last_result, e.modelUsage)) return null;
      first = item;
    } else if (
      !isRecord(e.origin) ||
      e.origin.kind !== "task-notification" ||
      e.origin.producer !== "session-task" ||
      !isDeepStrictEqual(e.model_usage_since_last_result, {}) ||
      e.total_cost_usd !== first.value.total_cost_usd ||
      !isDeepStrictEqual(e.modelUsage, first.value.modelUsage)
    )
      return null;
  }
  if (!first || index < 2 || init !== index) return null;
  const entry = first;
  const { usage } = await parseClaudeStream(
    (async function* () {
      yield entry;
    })(),
  );
  if (!usage || !Object.keys(usage.byModel).length) return null;
  const rows = Object.values(usage.byModel);
  if (rows.some((r) => r.costUsd == null) || Math.abs(rows.reduce((n, r) => n + r.costUsd!, 0) - usage.totalCostUsd!) > 0.000001)
    return null;
  return usage;
}
