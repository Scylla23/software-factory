import { lstatSync, realpathSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { assertPrivateDir } from "./config";
import { isRecord, readJsonl, type JsonlItem } from "./jsonl";
import { outputDigest, type NativeWrite } from "./output";

/** Match assistant Write requests to native success records in a factory-owned Claude transcript. */
export async function claudeWrites(
  identity: { taskId: string; attemptId: string; sessionId: string; role: string },
  stateRoot: string, claudeHome: string, outDir: string, childId?: string, childStream?: { startCall: string; events: AsyncIterable<JsonlItem> },
) {
  const id = identity.attemptId;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ||
      (childId ? !/^[a-z0-9]+$/.test(childId) || childId !== identity.sessionId : identity.sessionId !== id))
    throw new Error("invalid Claude output identity");
  assertPrivateDir(claudeHome, stateRoot);
  const path = transcript(claudeHome, id, childId);
  const requests = new Map<string, { file: string; content: unknown; assistant: unknown }>();
  const records = new Map<string, NativeWrite>();
  const seen = new Set<string>();
  const confirmations = childId && childStream ? await childWriteConfirmations(identity, childStream) : undefined;
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
      const nativeResult = isRecord(result) && ["create","update"].includes(String(result.type)) && result.filePath === submitted.file &&
        result.content === submitted.content && result.userModified !== true;
      const live = confirmations?.get(c.tool_use_id);
      const confirmed = childId && live && live.file === submitted.file && live.content === submitted.content && typeof live.resultUuid === "string" && live.resultUuid === e.uuid &&
        isRecord(e.permissionDecision) && e.permissionDecision.decision === "accept";
      if ((!nativeResult && !confirmed) || typeof submitted.content !== "string" ||
          !submitted.content.isWellFormed() || !submitted.assistant || submitted.assistant !== e.sourceToolAssistantUUID)
        throw new Error("incomplete Claude native submission");
      records.set(rel, { ...identity, path: rel, sha256: outputDigest(Buffer.from(submitted.content)) });
    }
  }
  if (requests.size) throw new Error(`unsettled native write in ${basename(path)}`);
  return [...records.values()];
}

function transcript(claudeHome: string, id: string, childId?: string) {
  const projects = join(claudeHome, "projects");
  const pattern = childId ? `*/${id}/subagents/**/agent-${childId}.jsonl` : `*/${id}.jsonl`;
  const paths = [...new Bun.Glob(pattern).scanSync(projects)];
  if (paths.length !== 1) throw new Error("missing or ambiguous Claude output transcript");
  const path = join(projects, paths[0]!);
  const stat = lstatSync(path);
  if (realpathSync(path) !== path || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o022))
    throw new Error("unsafe Claude output transcript");
  return path;
}

/** Authenticate a child identity against the parent's native Agent call and its success metadata. */
export async function claudeChildStarts(stateRoot: string, home: string, attempt: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(attempt)) throw new Error("invalid Claude attempt");
  assertPrivateDir(home, stateRoot);
  const requests = new Map<string, {role: string; uuid: string; line: number}>();
  const children = new Map<string, {role: string; startCall: string; started: number; completed: number | null}>();
  for await (const line of readJsonl(transcript(home, attempt))) {
    if (line.kind !== "record") throw new Error("invalid Claude parent record");
    const e = line.value;
    if (e.sessionId !== attempt || e.isSidechain !== false || !isRecord(e.message) || !Array.isArray(e.message.content)) continue;
    for (const c of e.message.content) {
      if (!isRecord(c)) continue;
      if (e.type === "assistant" && c.type === "tool_use" && c.name === "Agent" && isRecord(c.input) && typeof c.input.subagent_type === "string" && typeof c.id === "string" && typeof e.uuid === "string") {
        if (requests.has(c.id)) throw new Error("duplicate agent call");
        requests.set(c.id, {role:c.input.subagent_type, uuid:e.uuid, line:line.line});
      }
      const r = e.toolUseResult;
      if (e.type !== "user" || c.type !== "tool_result" || c.is_error || typeof c.tool_use_id !== "string" || !isRecord(r) || typeof r.agentId !== "string") continue;
      const req = requests.get(c.tool_use_id);
      if (!req || req.uuid !== e.sourceToolAssistantUUID || !["completed","async_launched"].includes(String(r.status)) ||
          (r.agentType !== undefined && r.agentType !== req.role) || children.has(r.agentId))
        throw new Error("ambiguous Claude child identity");
      children.set(r.agentId, {role:req.role, startCall:c.tool_use_id, started:req.line, completed:r.status === "completed" ? line.line : null});
    }
  }
  return children;
}

/** Only outer harness envelopes qualify. Tool output text is never parsed as a receipt. */
async function childWriteConfirmations(identity: {sessionId:string; attemptId:string; role:string},
  stream: {startCall:string; events:AsyncIterable<JsonlItem>}) {
  const records = new Map<string, {file:string; content:string; resultUuid?:string}>();
  for await (const line of stream.events) {
    if (line.kind !== "record") throw new Error("invalid Claude child event stream");
    const e = line.value;
    if (e.agent_id !== identity.sessionId || e.parent_tool_use_id !== stream.startCall || e.subagent_type !== identity.role ||
        e.session_id !== identity.attemptId || !isRecord(e.message) || !Array.isArray(e.message.content)) continue;
    for (const c of e.message.content) {
      if (!isRecord(c)) continue;
      if (e.type === "assistant" && c.type === "tool_use" && c.name === "Write" && typeof c.id === "string" &&
          isRecord(c.input) && typeof c.input.file_path === "string" && typeof c.input.content === "string") {
        if (records.has(c.id)) throw new Error("duplicate child write in stream");
        records.set(c.id,{file:c.input.file_path, content:c.input.content});
      }
      if (e.type !== "user" || c.type !== "tool_result" || typeof c.tool_use_id !== "string") continue;
      const req = records.get(c.tool_use_id);
      if (!req) continue;
      if (req.resultUuid) throw new Error("duplicate child response in stream");
      if (c.is_error || !Array.isArray(e.tool_result_meta) || !e.tool_result_meta.some(meta => isRecord(meta) && meta.id === c.tool_use_id &&
          isRecord(meta.permission_decision) && meta.permission_decision.decision === "accept") || typeof e.uuid !== "string") records.delete(c.tool_use_id);
      else req.resultUuid = e.uuid;
    }
  }
  return records;
}
