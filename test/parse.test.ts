import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseClaudeStream } from "../src/dispatch/claude";
import { codexSessionModel, findCodexSessionFile, parseCodexEvents } from "../src/dispatch/codex";

// Fixtures are real spike runs (docs/spikes/01-dispatch.md) with home paths and personal lists scrubbed.
const fixture = (name: string) => Bun.file(join(import.meta.dir, "fixtures", name)).text();
const SESSIONS = join(import.meta.dir, "fixtures", "codex-sessions");
const CODEX_THREAD = "01a1efae-7fd6-7ba1-a645-e89ed21cfbdb";

describe("parseClaudeStream", () => {
  test("completed run: session, observed model, usage, result", async () => {
    const s = parseClaudeStream(await fixture("claude-headless.stream.jsonl"));
    expect(s).toEqual({
      sessionId: "04fdfd03-327c-4f04-8a7c-b1d5df6a3357",
      observedModel: "claude-haiku-5-5",
      succeeded: true,
      resultText: "PELICAN",
      usage: {
        harness: "claude",
        totalCostUsd: 0.00144798,
        byModel: {
          "claude-haiku-5-5": {
            inputTokens: 4,
            outputTokens: 372,
            cacheReadInputTokens: 19298,
            cacheCreationInputTokens: 5343,
            costUsd: 0.00144798,
          },
        },
      },
    });
  });

  test("cancelled run: session and model from init, no result, usage unknown", async () => {
    const s = parseClaudeStream(await fixture("claude-cancelled.stream.jsonl"));
    expect(s.sessionId).toBe("bc9af034-b9da-4df0-862c-57463c1afccf");
    expect(s.observedModel).toBe("claude-haiku-5-5");
    expect(s.succeeded).toBe(false);
    expect(s.usage).toBeNull();
  });

  test("a truncated last line is ignored", async () => {
    const text = await fixture("claude-headless.stream.jsonl");
    const s = parseClaudeStream(`${text}{"type":"result","subtype":"succ`);
    expect(s.succeeded).toBe(true);
  });

  test("error result is not success and malformed usage is unknown, not zero", () => {
    const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m" });
    const result = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, session_id: "s", total_cost_usd: 0.1, modelUsage: { m: { inputTokens: 1 } } });
    const s = parseClaudeStream(`${init}\n${result}\n`);
    expect(s.succeeded).toBe(false);
    expect(s.usage).toBeNull();
  });
});

describe("parseCodexEvents", () => {
  test("completed run: thread id, usage, final message", async () => {
    expect(parseCodexEvents(await fixture("codex-headless.jsonl"))).toEqual({
      threadId: CODEX_THREAD,
      succeeded: true,
      resultText: "PELICAN",
      usage: {
        harness: "codex",
        inputTokens: 19356,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 7,
        reasoningOutputTokens: 0,
      },
    });
  });

  test("cancelled run: thread id known, no turn.completed, usage unknown", async () => {
    const s = parseCodexEvents(await fixture("codex-cancelled.jsonl"));
    expect(s.threadId).toBe("01a1efaf-6464-7c53-81f7-67d1aa470cb8");
    expect(s.succeeded).toBe(false);
    expect(s.usage).toBeNull();
  });

  test("usage sums across turns", async () => {
    const text = await fixture("codex-headless.jsonl");
    const turn = text.split("\n").find((l) => l.includes("turn.completed"))!;
    const s = parseCodexEvents(`${text}${turn}\n`);
    expect(s.usage?.inputTokens).toBe(2 * 19356);
    expect(s.usage?.outputTokens).toBe(14);
  });

  test("turn.failed marks the run failed", async () => {
    const text = await fixture("codex-headless.jsonl");
    expect(parseCodexEvents(`${text}{"type":"turn.failed","error":{"message":"x"}}\n`).succeeded).toBe(false);
  });
});

describe("Codex session file", () => {
  test("finds the rollout file by thread id and reads the observed model", async () => {
    const file = await findCodexSessionFile(SESSIONS, CODEX_THREAD);
    expect(file).toEndWith(`2026/11/18/rollout-2026-11-18T22-52-33-${CODEX_THREAD}.jsonl`);
    expect(codexSessionModel(await Bun.file(file!).text())).toBe("gpt-6-luna");
  });

  test("returns null for an unknown thread", async () => {
    expect(await findCodexSessionFile(SESSIONS, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  test("rejects a thread id that is not a UUID, so it cannot widen the glob", async () => {
    await expect(findCodexSessionFile(SESSIONS, "*")).rejects.toThrow("not a Codex thread id");
  });

  test("the last turn_context wins when the model changes mid-session", () => {
    const lines = [
      { type: "turn_context", payload: { model: "gpt-6-luna" } },
      { type: "turn_context", payload: { model: "gpt-6-sol" } },
    ].map((l) => JSON.stringify(l));
    expect(codexSessionModel(lines.join("\n"))).toBe("gpt-6-sol");
    expect(codexSessionModel("")).toBeNull();
  });
});
