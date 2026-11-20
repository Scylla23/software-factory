import type { DispatchConfig } from "../src/dispatch/config";
import { parseCodexEvents } from "../src/dispatch/codex";
import { readJsonl } from "../src/dispatch/jsonl";
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
