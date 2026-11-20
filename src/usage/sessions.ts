import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { codexTurnUsage, findCodexSessionFile } from "../dispatch/codex";
import { count, money, safeSessionFile, sessionUuid } from "../dispatch/validation";
import { assertPrivateDir, type DispatchConfig } from "../dispatch/config";
import { isRecord, readJsonl, str } from "../dispatch/jsonl";
import { codexLine, primary, summarize, type Line, type RunUsage } from "./capture";
import { estimate } from "./prices";

async function claudeMessages(root: string, session: string, lines: Map<string, Line>) {
  const paths: string[] = [];
  for await (const name of new Bun.Glob(`*/${session}.jsonl`).scan({ cwd: root, followSymlinks: false })) paths.push(join(root, name));
  if (paths.length !== 1 || !safeSessionFile(paths[0]!)) return null;
  const children = join(dirname(paths[0]!), session, "subagents");
  // Native child transcripts are confined to this parent's own session directory.
  if (lstatSync(children, { throwIfNoEntry: false })?.isDirectory() && realpathSync(children) === children) {
    for await (const file of new Bun.Glob("agent-*.jsonl").scan({ cwd: children, followSymlinks: false })) paths.push(join(children, file));
  }
  let mainModel: string | null = null;
  for (const path of paths) {
    const child = path !== paths[0];
    const localWrites = new Map<string, { short: number; hour: number }>();
    if (!safeSessionFile(path)) continue;
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
      const name = str(model) || null;
      if (!child) mainModel = name;
      if (child && lines.has(id) && !localWrites.has(id)) continue;
      const previous = lines.get(id);
      const split = isRecord(u.cache_creation) ? u.cache_creation : {};
      const hour = split.ephemeral_1h_input_tokens ?? 0;
      const short = split.ephemeral_5m_input_tokens ?? 0;
      const validSplit = count(short) && count(hour) && short + hour <= cacheWrite;
      const before = localWrites.get(id);
      const writes = {
        short: Math.max(before?.short ?? 0, validSplit ? short : 0),
        hour: Math.max(before?.hour ?? 0, validSplit ? hour : 0),
      };
      localWrites.set(id, writes);
      const t = {
        input: Math.max(previous?.input ?? 0, input),
        cacheRead: Math.max(previous?.cacheRead ?? 0, cacheRead),
        cacheWrite: Math.max(previous?.cacheWrite ?? 0, cacheWrite, writes.short + writes.hour),
        output: Math.max(previous?.output ?? 0, output),
        reasoning: count(reasoning) && reasoning <= output ? Math.max(previous?.reasoning ?? 0, reasoning) : previous?.reasoning ?? null,
      };
      lines.set(id, { ...t, model: name, costUsd: validSplit ? estimate(name, t, writes.hour, true) : null });
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

export async function captureRun(run: RunUsage, locations: Pick<DispatchConfig, "stateRoot" | "harnessHomes">) {
  const direct = run.harness === "claude" && !run.usage && money(run.reportedCostUsd)
    ? summarize([], "result", false, run.reportedCostUsd)
    : primary(run.usage, run.observedModel, run.outcome);
  const session = run.sessionId ?? (run.harness === "claude" ? run.runId : null);
  let observed = run.observedModel;
  const result = (capture: typeof direct) => ({ session, observed, capture });
  if ((direct.lines.length && (observed || run.harness !== "codex")) || !session || !sessionUuid.test(session)
      || (run.harness === "claude" && session !== run.runId)) return result(direct);
  const lines = new Map<string, Line>();
  try {
    const claude = run.harness === "claude";
    const home = assertPrivateDir(locations.harnessHomes[run.harness], locations.stateRoot);
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
