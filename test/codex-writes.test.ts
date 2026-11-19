import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexWrites } from "../src/dispatch/codex-writes";
import { outputDigest } from "../src/dispatch/output";
import { makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
const identity = { taskId: "task", attemptId: crypto.randomUUID(), sessionId: crypto.randomUUID(), role: "triage" };
let path: string, out: string, target: string;
beforeEach(() => {
  sb = makeSandbox();
  const day = join(sb.codexHome, "sessions/2026/11/20");
  mkdirSync(day, { recursive: true });
  path = join(day, `rollout-probe-${identity.sessionId}.jsonl`);
  out = join(sb.home, "out");
  target = join(out, "triage.json");
});
afterEach(() => sb.cleanup());
const meta = { type: "session_meta", payload: { id: identity.sessionId, source: "exec", thread_source: "user" } };
function changed(change: unknown, status = "completed", session = identity.sessionId as string) {
  return { type: "event_msg", payload: { type: "item_completed", thread_id: session,
    item: { type: "FileChange", status, changes: { [target]: change } } } };
}
function capture(...records: unknown[]) {
  writeFileSync(path, records.map(r => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  return codexWrites(identity, sb.stateRoot, sb.codexHome, out);
}
test("binds the native FileChange bytes and rejects incomplete or misattributed submissions", async () => {
  const bytes = "α\r\n";
  const add = changed({ type: "add", content: bytes });
  expect(await capture(meta, add)).toEqual([{ ...identity, path: "triage.json", sha256: outputDigest(Buffer.from(bytes)) }]);
  expect(await capture(meta, add, changed({ type: "update", unified_diff: "partial" }))).toEqual([]);
  expect(await capture(meta, changed({ type: "add", content: bytes }, "failed"))).toEqual([]);
  expect(await capture(meta, { type: "response_item", payload: { type: "message", content: JSON.stringify(add) } })).toEqual([]);
  expect(await capture(meta, { type: "event_msg", payload: { ...add.payload, item: { type: "CommandExecution", stdout: JSON.stringify(add) } } })).toEqual([]);
  await expect(capture(meta, changed({ type: "add" }))).rejects.toThrow("incomplete");
  await expect(capture(meta, changed({ type: "add", content: bytes }, "completed", "another"))).rejects.toThrow("unbound");
  await expect(capture(add, meta)).rejects.toThrow("unbound");
  await expect(capture({ type: "session_meta", payload: { ...meta.payload, source: "subagent" } }, add)).rejects.toThrow("mismatch");
});
