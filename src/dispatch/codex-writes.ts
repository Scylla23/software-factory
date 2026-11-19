import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { findCodexSessionFile } from "./codex";
import { assertPrivateDir, isUnder } from "./config";
import { isRecord, readJsonl } from "./jsonl";
import { outputDigest, type NativeWrite } from "./output";

/** Read only the harness's typed FileChange inventory from its dedicated, read-denied home. */
export async function codexWrites(
  identity: { taskId: string; attemptId: string; sessionId: string; role: string },
  stateRoot: string, codexHome: string, outDir: string,
): Promise<NativeWrite[]> {
  assertPrivateDir(codexHome, stateRoot);
  const sessions = join(codexHome, "sessions");
  const path = await findCodexSessionFile(sessions, identity.sessionId);
  if (!path || realpathSync(path) !== path || !isUnder(path, sessions)) throw new Error("missing protected Codex rollout");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o022))
    throw new Error("unsafe Codex rollout");
  const writes = new Map<string, NativeWrite>();
  let identified = false;
  for await (const record of readJsonl(path)) {
    if (record.kind !== "record") throw new Error("invalid Codex rollout record");
    const { type, payload } = record.value;
    if (!isRecord(payload)) continue;
    if (type === "session_meta") {
      if (payload.id !== identity.sessionId || payload.source !== "exec" || payload.thread_source !== "user")
        throw new Error("Codex output session mismatch");
      identified = true;
    }
    if (type !== "event_msg" || payload.type !== "item_completed" || !isRecord(payload.item) || payload.item.type !== "FileChange") continue;
    if (!identified || payload.thread_id !== identity.sessionId) throw new Error("unbound Codex native write");
    const item = payload.item;
    if (!isRecord(item.changes)) throw new Error("incomplete Codex native write");
    for (const [target, change] of Object.entries(item.changes)) {
      // A move from the worktree can replace a previously submitted output.
      if (!isRecord(change) || !["add", "update", "delete"].includes(String(change.type))) throw new Error("unknown native change");
      if (typeof change.move_path === "string" && isUnder(change.move_path, outDir))
        throw new Error("moved output lacks a whole-file submission");
      if (!isAbsolute(target)) throw new Error("relative Codex native change");
      const rel = relative(outDir, target);
      if (rel === ".." || rel.startsWith("../")) continue;
      if (!rel || join(outDir, rel) !== target) throw new Error("ambiguous output path");
      writes.delete(rel);
      if (item.status !== "completed" || change.type !== "add") continue;
      if (typeof change.content !== "string" || !change.content.isWellFormed()) throw new Error("incomplete Codex output bytes");
      writes.set(rel, { ...identity, path: rel, sha256: outputDigest(Buffer.from(change.content, "utf8")) });
    }
  }
  if (!identified) throw new Error("Codex rollout lacks session metadata");
  return [...writes.values()];
}
