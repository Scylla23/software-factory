import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeStream } from "../src/dispatch/claude";
import { codexSessionModel, findCodexSessionFile, parseCodexEvents } from "../src/dispatch/codex";
import { type JsonlItem, readJsonl } from "../src/dispatch/jsonl";
import { FIXTURES, fixture, writeLines } from "./helpers";

// Fixtures are real spike runs (docs/spikes/01-dispatch.md) with home paths and personal lists scrubbed.
const SESSIONS = join(FIXTURES, "codex-sessions");
const CODEX_THREAD = "01a1efae-7fd6-7ba1-a645-e89ed21cfbdb";
const tmp = mkdtempSync(join(tmpdir(), "dispatch-parse-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const fixtureLines = async (name: string) => (await Bun.file(fixture(name)).text()).trimEnd().split("\n");

async function collect(items: AsyncIterable<JsonlItem>): Promise<JsonlItem[]> {
  const out: JsonlItem[] = [];
  for await (const item of items) out.push(item);
  return out;
}

describe("readJsonl", () => {
  test("distinguishes a truncated final line from interior corruption, and skips blank lines", async () => {
    const path = writeLines(tmp, "mixed.jsonl", ['{"a":1}', "{broken", "", "[1]", '{"b":2}', '{"c":'], false);
    const items = await collect(readJsonl(path));
    expect(items.map((i) => (i.kind === "record" ? `record:${i.line}` : `${i.reason}:${i.line}:${i.truncatedTail}`))).toEqual([
      "record:1",
      "malformed:2:false",
      "not-object:4:false",
      "record:5",
      "malformed:6:true",
    ]);
  });

  test("bounds each record: an oversize line is reported without buffering it, and parsing continues", async () => {
    const path = join(tmp, "big.jsonl");
    writeFileSync(path, `{"x":"${"y".repeat(5000)}"}\n{"ok":true}\n`);
    const items = await collect(readJsonl(path, 1024));
    expect(items[0]).toMatchObject({ kind: "invalid", reason: "oversize", line: 1, truncatedTail: false });
    expect(items[1]).toMatchObject({ kind: "record", line: 2, value: { ok: true } });
  });

  test("reassembles records split across stream chunks", async () => {
    const path = join(tmp, "chunks.jsonl");
    const records = Array.from({ length: 400 }, (_, i) => JSON.stringify({ i, pad: "z".repeat(1000) }));
    writeFileSync(path, records.join("\n") + "\n");
    const items = await collect(readJsonl(path));
    expect(items.length).toBe(400);
    expect(items.every((it, i) => it.kind === "record" && it.value.i === i)).toBe(true);
  });
});

describe("parseClaudeStream", () => {
  test("completed run: session, observed model, usage, result", async () => {
    const s = await parseClaudeStream(readJsonl(fixture("claude-headless.stream.jsonl")));
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
      diagnostics: [],
    });
  });

  test("cancelled run: session and model from init, no result, usage unknown", async () => {
    const s = await parseClaudeStream(readJsonl(fixture("claude-cancelled.stream.jsonl")));
    expect(s.sessionId).toBe("bc9af034-b9da-4df0-862c-57463c1afccf");
    expect(s.observedModel).toBe("claude-haiku-5-5");
    expect(s.succeeded).toBe(false);
    expect(s.usage).toBeNull();
  });

  test("a truncated final line is reported as such and does not hide the result", async () => {
    const path = writeLines(tmp, "claude-trunc.jsonl", [...(await fixtureLines("claude-headless.stream.jsonl")), '{"type":"result","subtype":"succ'], false);
    const s = await parseClaudeStream(readJsonl(path));
    expect(s.succeeded).toBe(true);
    expect(s.diagnostics).toEqual([expect.stringContaining("truncated final record")]);
  });

  test("error result is not success and malformed usage is unknown, not zero", async () => {
    const path = writeLines(tmp, "claude-err.jsonl", [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m" }),
      JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, session_id: "s", total_cost_usd: 0.1, modelUsage: { m: { inputTokens: 1 } } }),
    ]);
    const s = await parseClaudeStream(readJsonl(path));
    expect(s.succeeded).toBe(false);
    expect(s.usage).toBeNull();
    expect(s.diagnostics).toEqual([expect.stringContaining("malformed usage")]);
  });

  test("two result events make accounting ambiguous: usage unknown", async () => {
    const lines = await fixtureLines("claude-headless.stream.jsonl");
    const path = writeLines(tmp, "claude-two.jsonl", [...lines, lines.at(-1)!]);
    const s = await parseClaudeStream(readJsonl(path));
    expect(s.usage).toBeNull();
    expect(s.succeeded).toBe(false);
  });
});

describe("parseCodexEvents", () => {
  test("completed run: thread id, usage, final message", async () => {
    expect(await parseCodexEvents(readJsonl(fixture("codex-headless.jsonl")))).toEqual({
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
      diagnostics: [],
    });
  });

  test("cancelled run: thread id known, no turn.completed, usage unknown", async () => {
    const s = await parseCodexEvents(readJsonl(fixture("codex-cancelled.jsonl")));
    expect(s.threadId).toBe("01a1efaf-6464-7c53-81f7-67d1aa470cb8");
    expect(s.succeeded).toBe(false);
    expect(s.usage).toBeNull();
  });

  test("usage sums across intact turns", async () => {
    const lines = await fixtureLines("codex-headless.jsonl");
    const turn = lines.find((l) => l.includes("turn.completed"))!;
    const s = await parseCodexEvents(readJsonl(writeLines(tmp, "codex-two.jsonl", [...lines, turn])));
    expect(s.usage?.inputTokens).toBe(2 * 19356);
    expect(s.usage?.outputTokens).toBe(14);
  });

  test("valid, malformed-usage, valid turns: usage stays unknown instead of reviving partial totals", async () => {
    const lines = await fixtureLines("codex-headless.jsonl");
    const turn = lines.find((l) => l.includes("turn.completed"))!;
    const bad = JSON.stringify({ type: "turn.completed", usage: { input_tokens: "many" } });
    const s = await parseCodexEvents(readJsonl(writeLines(tmp, "codex-vmv.jsonl", [...lines, bad, turn])));
    expect(s.usage).toBeNull();
    expect(s.succeeded).toBe(false);
    expect(s.diagnostics).toEqual([expect.stringContaining("malformed usage")]);
  });

  test("an interior corrupt line makes usage unknown and is reported as corruption", async () => {
    const lines = await fixtureLines("codex-headless.jsonl");
    const s = await parseCodexEvents(readJsonl(writeLines(tmp, "codex-corrupt.jsonl", [lines[0]!, "not json", ...lines.slice(1)])));
    expect(s.usage).toBeNull();
    expect(s.succeeded).toBe(false);
    expect(s.diagnostics).toEqual(["line 2: corrupt record (malformed)"]);
  });

  test("a truncated final line is reported as truncation, not corruption", async () => {
    const lines = await fixtureLines("codex-headless.jsonl");
    const s = await parseCodexEvents(readJsonl(writeLines(tmp, "codex-trunc.jsonl", [...lines, '{"type":"turn.compl'], false)));
    expect(s.usage).toBeNull();
    expect(s.diagnostics).toEqual([expect.stringContaining("truncated final record")]);
  });

  test("turn.failed marks the run failed", async () => {
    const lines = await fixtureLines("codex-headless.jsonl");
    const s = await parseCodexEvents(readJsonl(writeLines(tmp, "codex-failed.jsonl", [...lines, '{"type":"turn.failed","error":{"message":"x"}}'])));
    expect(s.succeeded).toBe(false);
  });
});

describe("Codex session file", () => {
  test("finds the rollout file by thread id and reads the observed model", async () => {
    const file = await findCodexSessionFile(SESSIONS, CODEX_THREAD);
    expect(file).toEndWith(`2026/11/18/rollout-2026-11-18T22-52-33-${CODEX_THREAD}.jsonl`);
    expect(await codexSessionModel(file!)).toBe("gpt-6-luna");
  });

  test("returns null for an unknown thread", async () => {
    expect(await findCodexSessionFile(SESSIONS, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  test("rejects a thread id that is not a UUID, so it cannot widen the glob", async () => {
    await expect(findCodexSessionFile(SESSIONS, "*")).rejects.toThrow("not a Codex thread id");
  });

  test("the last turn_context wins, and oversize records around it are skipped", async () => {
    const path = join(tmp, "rollout.jsonl");
    const huge = JSON.stringify({ type: "response_item", payload: { text: "q".repeat(9 * 1024 * 1024) } });
    const ctx = (model: string) => JSON.stringify({ type: "turn_context", payload: { model } });
    writeFileSync(path, [ctx("gpt-6-luna"), huge, ctx("gpt-6-sol"), huge].join("\n") + "\n");
    expect(await codexSessionModel(path)).toBe("gpt-6-sol");
  });
});
