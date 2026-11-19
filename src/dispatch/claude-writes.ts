import { lstatSync, realpathSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { assertPrivateDir } from "./config";
import { isRecord, readJsonl } from "./jsonl";
import { outputDigest, type NativeWrite } from "./output";

/** Match assistant Write requests to native success records in a factory-owned Claude transcript. */
export async function claudeWrites(
  identity: { taskId: string; attemptId: string; sessionId: string; role: string },
  stateRoot: string, claudeHome: string, outDir: string, childId?: string,
) {
  const id = identity.attemptId;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ||
      (childId ? !/^[a-z0-9]+$/.test(childId) || childId !== identity.sessionId : identity.sessionId !== id))
    throw new Error("invalid Claude output identity");
  assertPrivateDir(claudeHome, stateRoot);
  const projects = join(claudeHome, "projects");
  const pattern = childId ? `*/${id}/subagents/**/agent-${childId}.jsonl` : `*/${id}.jsonl`;
  const paths = [...new Bun.Glob(pattern).scanSync(projects)];
  if (paths.length !== 1) throw new Error("missing or ambiguous Claude output transcript");
  const path = join(projects, paths[0]!);
  const stat = lstatSync(path);
  if (realpathSync(path) !== path || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o022))
    throw new Error("unsafe Claude output transcript");
  const requests = new Map<string, { file: string; content: unknown; assistant: unknown }>();
  const records = new Map<string, NativeWrite>();
  const seen = new Set<string>();
  for await (const line of readJsonl(path)) {
    if (line.kind !== "record") throw new Error("invalid Claude output record");
    const e = line.value;
    if (!["assistant","user"].includes(String(e.type))) continue;
    if (e.sessionId !== id || (childId ? e.agentId !== childId || e.isSidechain !== true : e.isSidechain !== false))
      throw new Error("Claude output transcript identity mismatch");
    if (!isRecord(e.message) || !Array.isArray(e.message.content)) continue;
    for (const c of e.message.content) {
      if (!isRecord(c)) continue;
      if (e.type === "assistant" && c.type === "tool_use" && ["Write","Edit"].includes(String(c.name))) {
        if (!isRecord(c.input) || typeof c.input.file_path !== "string" || typeof c.id !== "string" || seen.has(c.id))
          throw new Error("ambiguous Claude native write");
        seen.add(c.id);
        const file = c.input.file_path;
        if (!file.startsWith(outDir + "/")) continue;
        if (join(outDir, relative(outDir, file)) !== file) throw new Error("ambiguous Claude output path");
        requests.set(c.id, { file, content: c.name === "Write" ? c.input.content : null, assistant: e.uuid });
      }
      if (e.type !== "user" || c.type !== "tool_result" || typeof c.tool_use_id !== "string") continue;
      const submitted = requests.get(c.tool_use_id);
      if (!submitted) continue;
      requests.delete(c.tool_use_id);
      const rel = relative(outDir, submitted.file);
      records.delete(rel);
      if (c.is_error === true || submitted.content === null) continue;
      const result = e.toolUseResult;
      if (!isRecord(result) || !["create","update"].includes(String(result.type)) || result.filePath !== submitted.file ||
          result.content !== submitted.content || result.userModified === true || typeof submitted.content !== "string" ||
          !submitted.content.isWellFormed() || !submitted.assistant || submitted.assistant !== e.sourceToolAssistantUUID)
        throw new Error("incomplete Claude native submission");
      records.set(rel, { ...identity, path: rel, sha256: outputDigest(Buffer.from(submitted.content)) });
    }
  }
  if (requests.size) throw new Error(`unsettled native write in ${basename(path)}`);
  return [...records.values()];
}
