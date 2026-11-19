import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { codexTurnUsage, findCodexSessionFile } from "../dispatch/codex";
import { assertPrivateDir } from "../dispatch/config";
import { isRecord, readJsonl, str } from "../dispatch/jsonl";
import { codexLine, count, money, primary, summarize, type Line, type RunUsage } from "./capture";
import { estimate } from "./prices";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function safeFile(path: string) {
  const st = lstatSync(path);
  return st.isFile() && st.nlink === 1 && realpathSync(path) === path;
}

async function claudeMessages(root: string, session: string, lines: Map<string, Line>) {
  const paths: string[] = [];
  for await (const name of new Bun.Glob(`*/${session}.jsonl`).scan({ cwd: root, followSymlinks: false })) paths.push(join(root, name));
  if (paths.length !== 1 || !safeFile(paths[0]!)) return null;
  const children = join(dirname(paths[0]!), session, "subagents");
  // Native child transcripts are confined to this parent's own session directory.
  if (lstatSync(children, { throwIfNoEntry: false })?.isDirectory() && realpathSync(children) === children) {
    for await (const file of new Bun.Glob("agent-*.jsonl").scan({ cwd: children, followSymlinks: false })) paths.push(join(children, file));
  }
  let mainModel: string | null = null;
  for (const path of paths) {
    const child = path !== paths[0];
    const localIds = new Set<string>();
    if (!safeFile(path)) continue;
    for await (const item of readJsonl(path)) {
      if (item.kind !== "record") continue;
      const e = item.value;
      if (e.type !== "assistant" || e.sessionId !== session || !isRecord(e.message)) continue;
      if (child && (e.isSidechain !== true || e.agentId !== basename(path, ".jsonl").slice(6))) continue;
      const { id, model, usage: u } = e.message;
      if (typeof id !== "string" || !id || model === "<synthetic>" || !isRecord(u)) continue;
      const { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output } = u;
      if (!count(input) || !count(cacheRead) || !count(cacheWrite) || !count(output)) continue;
      const reasoning = isRecord(u.output_tokens_details) ? u.output_tokens_details.thinking_tokens : null;
      const t = { input, cacheRead, cacheWrite, output, reasoning: count(reasoning) && reasoning <= output ? reasoning : null };
      const longWrites = isRecord(u.cache_creation) ? u.cache_creation.ephemeral_1h_input_tokens : 0;
      const name = str(model) || null;
      if (!child) mainModel = name;
      if (child && lines.has(id) && !localIds.has(id)) continue;
      if (child) localIds.add(id);
      lines.set(id, { ...t, model: name,
        costUsd: count(longWrites) && longWrites <= cacheWrite ? estimate(name, t, longWrites, true) : null });
    }
  }
  return mainModel;
}

async function codexResponses(root: string, session: string, lines: Map<string, Line>) {
  const path = await findCodexSessionFile(root, session);
  if (!path) return null;
  const models = new Map<string, string>();
  let lastModel: string | null = null;
  let verified = false;
  for await (const item of readJsonl(path)) {
    if (item.kind !== "record") continue;
    const { type, payload: p } = item.value;
    if (!isRecord(p)) continue;
    if (type === "session_meta") {
      if (p.id !== session || (p.session_id !== undefined && p.session_id !== session)) {
        lines.clear();
        return null;
      }
      verified = true;
    }
    if (!verified) continue;
    if (type === "turn_context" && typeof p.turn_id === "string" && typeof p.model === "string") {
      models.set(p.turn_id, p.model);
      lastModel = p.model;
    }
    if (type !== "token_usage_record" || p.thread_id !== session || (p.session_id !== undefined && p.session_id !== session)
      || typeof p.response_id !== "string" || !p.response_id || lines.has(p.response_id)) continue;
    const usage = codexTurnUsage(p.usage);
    const model = models.get(str(p.turn_id) ?? "") ?? null;
    const line = usage && codexLine(model, { ...usage }, true);
    if (line) lines.set(p.response_id, line);
  }
  return lastModel;
}

export async function captureRun(run: RunUsage, stateRoot: string) {
  const direct = run.harness === "claude" && !run.usage && money(run.reportedCostUsd)
    ? summarize([], "result", false, run.reportedCostUsd)
    : primary(run.usage, run.observedModel, run.outcome);
  const session = run.sessionId ?? (run.harness === "claude" ? run.runId : null);
  let observed = run.observedModel;
  const result = (capture: typeof direct) => ({ session, observed, capture });
  if ((direct.lines.length && (observed || run.harness !== "codex")) || !session || !uuid.test(session)
      || (run.harness === "claude" && session !== run.runId)) return result(direct);
  const lines = new Map<string, Line>();
  try {
    const claude = run.harness === "claude";
    const home = assertPrivateDir(join(stateRoot, claude ? "claude-home" : "codex-home"), stateRoot);
    const root = join(home, claude ? "projects" : "sessions");
    if (realpathSync(root) !== root) return result(direct);
    const reader = claude ? claudeMessages : codexResponses;
    const model = await reader(root, session, lines);
    observed ??= model;
  } catch {
    // An unavailable transcript must never turn an otherwise usable worker receipt into a failure.
  }
  if (direct.lines.length) return result(primary(run.usage, observed, run.outcome));
  return result(lines.size ? summarize([...lines.values()], "session", false, direct.costUsd) : direct);
}
