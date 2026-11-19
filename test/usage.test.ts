import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, cpSync, linkSync, renameSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../factory.config";
import { parseClaudeStream } from "../src/dispatch/claude";
import { parseCodexEvents } from "../src/dispatch/codex";
import { readJsonl } from "../src/dispatch/jsonl";
import { primary, type RunUsage } from "../src/usage/capture";
import { estimate, priceFor } from "../src/usage/prices";
import { captureRun } from "../src/usage/sessions";

let root: string;
beforeEach(() => { root = mkdtempSync(join(realpathSync(tmpdir()), "usage-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const fixture = (name: string) => join(import.meta.dir, "fixtures/usage", name + ".jsonl");
const put = (path: string, from: string) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  copyFileSync(fixture(from), path);
};

async function replay(harness: "claude" | "codex", mode: "complete" | "killed") {
  const name = harness + "-" + mode;
  const items = readJsonl(fixture(name));
  let sessionId, usage, observedModel;
  if (harness === "claude") {
    ({ sessionId, usage, observedModel } = await parseClaudeStream(items));
  } else {
    ({ threadId: sessionId, usage } = await parseCodexEvents(items));
    observedModel = "gpt-6-luna";
  }
  const run: RunUsage = { harness, sessionId, usage, observedModel, requestedModel: harness === "claude" ? "haiku" : "gpt-6-luna",
    outcome: mode === "complete" ? "completed" : "timed_out", runId: harness === "claude" ? sessionId! : crypto.randomUUID() };
  const path = harness === "claude" ? join(root, "claude-home/projects/fixture", sessionId + ".jsonl")
    : join(root, "codex-home/sessions/2026/11/20", "rollout-fixture-" + sessionId + ".jsonl");
  put(path, name + "-session");
  return { path, run };
}

test.each(["claude", "codex"] as const)("%s result agrees with the independently recovered session", async harness => {
  const { run } = await replay(harness, "complete");
  const { capture } = await captureRun(run, root);
  const fallback = (await captureRun({ ...run, usage: null }, root)).capture;
  expect(capture.source).toBe("result");
  expect(capture.coverage).toBe("complete");
  expect(fallback.coverage).toBe("partial");
  const expected = harness === "codex" ? { input: 10658, cacheRead: 0, cacheWrite: 0, output: 7, reasoning: 0 }
    : { input: 2, cacheRead: 5427, cacheWrite: 6812, output: 7 };
  expect(capture.lines).toHaveLength(1);
  expect(fallback.lines).toHaveLength(1);
  expect(capture.lines[0]).toMatchObject(expected);
  expect(fallback.lines[0]).toMatchObject(expected);
  expect(capture.costUsd).toBeCloseTo(harness === "codex" ? 0.0010693 : 0.00142037, 10);
  expect(fallback.costUsd).toBeCloseTo(capture.costUsd!, 10);
});

test("killed Claude dedupes message fragments across parent and child and excludes copied history", async () => {
  const { path, run } = await replay("claude", "killed");
  const raw = readFileSync(path, "utf8");
  const msg = JSON.parse(raw);
  const child = join(dirname(path), run.sessionId!, "subagents/agent-child.jsonl");
  mkdirSync(dirname(child), { recursive: true });
  appendFileSync(path, raw + '{"broken":');
  const childMsg = { ...msg, agentId: "child", isSidechain: true, message: { ...msg.message, id: "child-msg" } };
  writeFileSync(child, [msg, { ...msg, message: { ...msg.message, id: "inherited-only" } }, childMsg, { ...childMsg, message: { ...childMsg.message, usage: { ...childMsg.message.usage, output_tokens: 84 } } },
    { ...childMsg, sessionId: crypto.randomUUID(), message: { ...msg.message, id: "foreign" } }].map(e => JSON.stringify(e)).join("\n"));
  const { capture, observed } = await captureRun({ ...run, sessionId: null, observedModel: null }, root);
  expect(observed).toBe("claude-haiku-5-5");
  expect(capture).toMatchObject({ source: "session", coverage: "partial" });
  expect(capture.lines.map(l => l.input)).toEqual([2, 2]);
  expect(capture.lines.map(l => l.cacheWrite)).toEqual([5038, 5038]);
  expect(capture.lines.map(l => l.output)).toEqual([82, 84]);
});

test("killed Codex charges only unique responses owned by the requested session", async () => {
  const { path, run } = await replay("codex", "killed");
  const msg = JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!);
  const copy = (p: object) => JSON.stringify({ ...msg, payload: { ...msg.payload, ...p } });
  appendFileSync(path, [copy({}), copy({ thread_id: crypto.randomUUID(), response_id: "foreign" }),
    copy({ session_id: crypto.randomUUID(), response_id: "foreign2" }), copy({ response_id: null })].join("\n"));
  const { capture, observed } = await captureRun({ ...run, observedModel: null }, root);
  expect(observed).toBe("gpt-6-luna");
  expect(capture).toMatchObject({ source: "session", coverage: "partial", lines: [{ input: 10660, output: 36 }] });
});

test.each(["claude","codex"] as const)("%s rejects links and foreign session IDs and preserves unknowns", async harness => {
  const { path, run } = await replay(harness, "killed");
  const foreign = join(root, "personal.jsonl");
  copyFileSync(path, foreign);
  rmSync(path);
  symlinkSync(foreign, path);
  for (const sessionId of [run.sessionId, crypto.randomUUID(), "../*"]) {
    const { capture } = await captureRun({ ...run, sessionId }, root);
    expect(capture).toMatchObject({ coverage: "unknown", costUsd: null, lines: [] });
  }
});

test("Standard prices cover every configured model and both observed cheap fixture models", () => {
  for (const model of [...Object.values(config.agents).map(a => a.model), "claude-haiku-5-5", "gpt-6-luna"]) {
    expect(priceFor(model)?.source).toStartWith("https://");
    expect(priceFor(model)!.input).toBeGreaterThan(0);
  }
  const t = { input: 300, output: 100, reasoning: 50, cacheRead: 400, cacheWrite: 200 };
  expect(estimate("gpt-6.2-sol", t)).toBeCloseTo(0.00214, 10);
  expect(estimate("unlisted", t)).toBeNull();
  expect(estimate(null, t)).toBeNull();
  expect(estimate("toString", t)).toBeNull();
});

test("Codex cached input, writes and reasoning are subsets and known zero survives", () => {
  const u = { harness: "codex", inputTokens: 900, cachedInputTokens: 400, cacheWriteInputTokens: 200, outputTokens: 100, reasoningOutputTokens: 50 };
  const c = primary(u, "gpt-6.2-sol", "completed");
  expect(c.lines[0]).toMatchObject({ input: 300, output: 100, reasoning: 50 });
  expect(c.costUsd).toBeCloseTo(0.00214, 10);
  expect(primary(u, null, "completed").costUsd).toBeNull();
  expect(primary({ ...u, inputTokens: 99 }, "gpt-6-luna", "completed").coverage).toBe("unknown");
  const zero = { ...u, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  expect(primary(zero, "gpt-6-luna", "completed").costUsd).toBe(0);
});

test("Claude keeps per-model usage and honors a provider total distinct from its parts", () => {
  const raw = { inputTokens: 1, cacheReadInputTokens: 2, cacheCreationInputTokens: 3, outputTokens: 4, costUsd: 0.1 };
  const c = primary({ harness: "claude", totalCostUsd: 0.25, byModel: { a: raw, b: raw } }, "a", "completed");
  expect(c.costUsd).toBe(0.25);
  expect(c.lines.map(l => [l.model, l.costUsd])).toEqual([["a",0.1],["b",0.1]]);
});

test("Claude preserves a reported cost even when only transcript tokens survive", async () => {
  const { path, run } = await replay("claude", "killed");
  const raw = { type: "result", session_id: run.sessionId, is_error: true, subtype: "error", total_cost_usd: 0.75 };
  const log = join(root, "exit.jsonl");
  writeFileSync(log, JSON.stringify(raw));
  const parsed = await parseClaudeStream(readJsonl(log));
  const incomplete = { ...run, usage: parsed.usage, reportedCostUsd: parsed.reportedCostUsd };
  expect((await captureRun(incomplete, root)).capture).toMatchObject({ source: "session", coverage: "partial", reportedTotal: true, costUsd: 0.75 });
  rmSync(path);
  expect((await captureRun(incomplete, root)).capture).toMatchObject({ source: "result", coverage: "unknown", reportedTotal: true, costUsd: 0.75 });
});

test("each recovered Codex response applies the request's context tier", () => {
  const tokens = { input: 272001, cacheRead: 5, cacheWrite: 10, output: 77, reasoning: 60 };
  expect(estimate("gpt-6-luna", tokens, 0, true)).toBeCloseTo((272001 * 0.2 + 5 * 0.02 + 10 * 0.25 + 77 * 0.75) / 1e6, 12);
});

test("omitted Codex write and reasoning counters stay unknown across turns", async () => {
  const path = join(root, "incomplete.jsonl");
  const usage = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 };
  const turn = (u: typeof usage) => JSON.stringify({ type: "turn.completed", usage: u });
  const measured = { ...usage, reasoning_output_tokens: 1, cache_write_input_tokens: 3 };
  writeFileSync(path, [turn(usage), turn(measured)].join("\n"));
  const result = await parseCodexEvents(readJsonl(path));
  const capture = primary(result.usage, "gpt-6-luna", "completed");
  expect(capture).toMatchObject({ coverage: "partial", costUsd: null,
    lines: [{ input: 16, cacheRead: 4, cacheWrite: null, output: 6, reasoning: null }] });
});

test.each(["claude","codex"] as const)("%s rejects a redirected session directory before enumeration", async harness => {
  const { run } = await replay(harness, "killed");
  const dir = join(root, harness + "-home", harness === "claude" ? "projects" : "sessions");
  renameSync(dir, join(root, "foreign"));
  symlinkSync(join(root, "foreign"), dir);
  const scan = spyOn(Bun.Glob.prototype, "scan");
  try {
    expect((await captureRun(run, root)).capture.coverage).toBe("unknown");
    expect(scan).not.toHaveBeenCalled();
  } finally { scan.mockRestore(); }
});

test.each(["leaf", "ancestor"])("Claude refuses to enumerate a redirected subagent directory at its %s", async component => {
  const { path, run } = await replay("claude","killed");
  const parent = join(dirname(path), run.sessionId!);
  const dir = join(parent, "subagents");
  mkdirSync(dir, { recursive: true });
  const source = component === "leaf" ? dir : parent;
  renameSync(source, join(root, "outside"));
  symlinkSync(join(root, "outside"), source);
  const scan = spyOn(Bun.Glob.prototype, "scan");
  try {
    expect((await captureRun(run, root)).capture.lines).toHaveLength(1);
    expect(scan.mock.calls.some(([options]) => typeof options === "object" && options.cwd === dir)).toBe(false);
  } finally { scan.mockRestore(); }
});

test.each(["claude","codex"] as const)("%s refuses a hardlinked transcript", async harness => {
  const { run, path } = await replay(harness,"killed");
  linkSync(path, join(root, "foreign.jsonl"));
  expect((await captureRun(run, root)).capture.lines).toEqual([]);
});

test("Claude refuses two project directories claiming the session", async () => {
  const { run } = await replay("claude","killed");
  put(join(root,"claude-home/projects/other",run.sessionId + ".jsonl"),"claude-killed-session");
  expect((await captureRun(run, root)).capture.lines).toEqual([]);
});

test.each(["id","session_id"])("Codex rejects foreign session metadata in %s before counting responses", async field => {
  const { path, run } = await replay("codex","killed");
  const records = readFileSync(path,"utf8").trim().split("\n").map(line => JSON.parse(line));
  records[0].payload[field] = crypto.randomUUID();
  writeFileSync(path, records.map(r => JSON.stringify(r)).join("\n"));
  expect((await captureRun(run, root)).capture.lines).toEqual([]);
});

test("Claude rejects a child claiming a different agent filename", async () => {
  const { path, run } = await replay("claude","killed");
  const msg = JSON.parse(readFileSync(path,"utf8"));
  msg.message.id = "child-only";
  const dir = join(dirname(path), run.sessionId!, "subagents");
  mkdirSync(dir,{ recursive:true });
  writeFileSync(join(dir,"agent-first.jsonl"),JSON.stringify({ ...msg, isSidechain:true, agentId:"second" }));
  expect((await captureRun(run, root)).capture.lines).toHaveLength(1);
});

test("Claude rejects a reported session differing from the dispatch UUID", async () => {
  const { run } = await replay("claude","killed");
  expect((await captureRun({ ...run, runId:crypto.randomUUID() },root)).capture.lines).toEqual([]);
});

test("Claude excludes synthetic assistant accounting", async () => {
  const { path, run } = await replay("claude","killed");
  const msg = JSON.parse(readFileSync(path,"utf8"));
  msg.message.model = "<synthetic>";
  writeFileSync(path, JSON.stringify(msg));
  expect((await captureRun(run, root)).capture.lines).toEqual([]);
});

test("Claude refuses a hardlinked child independently of its trusted parent", async () => {
  const { path, run } = await replay("claude","killed");
  const msg = JSON.parse(readFileSync(path,"utf8"));
  msg.message.id = "child-only";
  const child = join(dirname(path),run.sessionId!,"subagents/agent-child.jsonl");
  mkdirSync(dirname(child), { recursive:true });
  writeFileSync(child,JSON.stringify({ ...msg, isSidechain:true, agentId:"child" }));
  linkSync(child,join(root,"outside.jsonl"));
  expect((await captureRun(run,root)).capture.lines).toHaveLength(1);
});

test("Claude ignores the entire child directory when its root transcript is untrusted", async () => {
  const { path, run } = await replay("claude","killed");
  const child = join(dirname(path),run.sessionId!,"subagents/agent-child.jsonl");
  mkdirSync(dirname(child), { recursive:true });
  writeFileSync(child,JSON.stringify({ ...JSON.parse(readFileSync(path,"utf8")), isSidechain:true, agentId:"child" }));
  linkSync(path,join(root,"elsewhere.jsonl"));
  expect((await captureRun(run,root)).capture.lines).toEqual([]);
});

test("live Haiku child and parent reconcile to the provider total and copied parent IDs remain single charges", async () => {
  const src = join(import.meta.dir, "fixtures/usage/claude-native-child");
  const result = await parseClaudeStream(readJsonl(join(src, "result.jsonl")));
  const session = result.sessionId!;
  const project = join(root, "claude-home/projects/fixture");
  mkdirSync(project,{ recursive:true, mode:0o700 });
  cpSync(src,project,{ recursive:true });
  const run: RunUsage = { harness:"claude", runId:session, sessionId:session, requestedModel:"haiku", observedModel:null, usage:null, outcome:"cancelled" };
  const read = () => captureRun(run, root);
  const initial = await read();
  const totals = initial.capture.lines.reduce((a,l) => [a[0]! + l.input,a[1]! + l.cacheRead,a[2]! + l.cacheWrite!,a[3]! + l.output], [0,0,0,0]);
  expect(totals).toEqual([6,2966,4806,209]);
  expect(initial.capture.lines).toHaveLength(3);
  expect(initial.capture.costUsd).toBeCloseTo(result.usage!.totalCostUsd!,12);
  const parent = JSON.parse(readFileSync(join(project,session + ".jsonl"),"utf8").split("\n")[0]!);
  const agentId = "a9fc78e873b88a229";
  parent.message.usage.output_tokens += 200;
  appendFileSync(join(project,session,"subagents","agent-" + agentId + ".jsonl"),JSON.stringify({ ...parent, isSidechain:true, agentId }));
  expect(await read()).toEqual(initial);
});

test("Haiku switches the entire request to the long-context rate above 100000 prompt tokens", () => {
  const t = { input:90000, cacheWrite:8000, cacheRead:2000, output:100, reasoning:0 };
  expect(estimate("claude-haiku-5-5",t,2000,true)).toBeCloseTo(0.01022,12);
  expect(estimate("claude-haiku-5-5",{ ...t, cacheRead:2001 },2000,true)).toBeCloseTo(0.05110005,12);
});

test("impossible Codex reasoning counts cannot produce a measured total", () => {
  const usage = { harness:"codex", inputTokens:10, cachedInputTokens:0, cacheWriteInputTokens:0, outputTokens:1, reasoningOutputTokens:2 };
  expect(primary(usage,"gpt-6-luna","completed")).toMatchObject({ coverage:"unknown", costUsd:null });
});

test("Claude reports partial tokens when one model's exit counters are broken", () => {
  const model = { inputTokens:50, cacheReadInputTokens:0, cacheCreationInputTokens:0, outputTokens:1, costUsd:0.2 };
  expect(primary({ harness:"claude", byModel:{ a:model, b:{ ...model, outputTokens:-1 } } },"a","completed"))
    .toMatchObject({ coverage:"partial", lines:[{model:"a"}] });
});

test("Claude observes the parent model independently of the child model", async () => {
  const { run, path } = await replay("claude","killed");
  const child = join(dirname(path),run.sessionId!,"subagents/agent-cheap.jsonl");
  mkdirSync(dirname(child), {recursive:true});
  const msg = JSON.parse(readFileSync(path,"utf8"));
  msg.message.model = "child-model";
  msg.message.id += "-child";
  writeFileSync(child,JSON.stringify({ ...msg,agentId:"cheap",isSidechain:true }));
  const capture = await captureRun({ ...run, observedModel:null },root);
  expect(capture.capture.lines.map(l => l.model)).toEqual(["claude-haiku-5-5","child-model"]);
  expect(capture.observed).toBe("claude-haiku-5-5");
});
