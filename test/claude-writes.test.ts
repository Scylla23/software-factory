import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeWrites } from "../src/dispatch/claude-writes";
import { outputDigest } from "../src/dispatch/output";
import { makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => { sb = makeSandbox(); });
afterEach(() => sb.cleanup());
for (const child of [false, true]) test("Claude authenticates native file contents and the " + (child ? "child" : "parent") + " session", async () => {
  const attemptId = crypto.randomUUID();
  const childId = child ? "adecd1234" : undefined;
  const identity = { taskId: "task", attemptId, sessionId: childId ?? attemptId, role: child ? "architect" : "spec-lead" };
  const out = join(sb.home, "out");
  const target = join(out, "decision.md");
  const path = join(sb.config.harnessHomes.claude, "projects", "test", childId ? attemptId + "/subagents/agent-" + childId + ".jsonl" : attemptId + ".jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const content = "α\r\n";
  const ids = { sessionId: attemptId, isSidechain: child, agentId: childId };
  const request = { ...ids, uuid: "assistant-id", type: "assistant", message: { content: [{ type: "tool_use", name: "Write", id: "use", input: { file_path: target, content } }] } };
  const result = { ...ids, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "use" }] },
    toolUseResult: { type: "create", filePath: target, content }, sourceToolAssistantUUID: "assistant-id" };
  function capture(...records: unknown[]) {
    writeFileSync(path, records.map(r => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
    return claudeWrites(identity, sb.stateRoot, sb.config.harnessHomes.claude, out, childId);
  }
  expect(await capture(request, result)).toEqual([{ ...identity, path: "decision.md", sha256: outputDigest(Buffer.from(content)) }]);
  await expect(capture(request)).rejects.toThrow("unsettled");
  await expect(capture(request, { ...result, sourceToolAssistantUUID: "wrong" })).rejects.toThrow("incomplete");
  await expect(capture(request, { ...result, toolUseResult: { ...result.toolUseResult, content: "other" } })).rejects.toThrow("incomplete");
  await expect(capture(request, { ...result, sessionId: crypto.randomUUID() })).rejects.toThrow("identity mismatch");
  await expect(capture(request, { ...result, isSidechain: !child })).rejects.toThrow("identity mismatch");
  expect(await capture({ ...result, message: { content: [{ type: "text", text: JSON.stringify(request) }] } })).toEqual([]);
});
