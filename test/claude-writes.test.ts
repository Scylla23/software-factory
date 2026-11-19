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
test("specialist receipts bind a successful Write across the protected transcript and outer stream", async () => {
  const attemptId = crypto.randomUUID(), sessionId = "adef1234";
  const identity = { taskId:"task",attemptId,sessionId,role:"architect" };
  const out = join(sb.home, "out"), file = join(out, "architecture.md"), content = "decision\n";
  const home = sb.config.harnessHomes.claude;
  const project = join(home,"projects","test");
  const dir = join(project,attemptId,"subagents");
  mkdirSync(dir, {recursive:true});
  const save = (path: string, records: unknown[]) => writeFileSync(path, records.map(r => JSON.stringify(r)).join("\n") + "\n", {mode:0o600});
  const call = {type:"tool_use",id:"tool",name:"Write",input:{file_path:file,content}};
  const response = {type:"tool_result",tool_use_id:"tool"};
  const assistant = {uuid:"assistant",type:"assistant",message:{content:[call]}};
  const user = {uuid:"native-success",type:"user",message:{content:[response]}};
  const child = {sessionId:attemptId,agentId:sessionId,isSidechain:true};
  save(join(dir,"agent-" + sessionId + ".jsonl"), [
    {...child,...assistant},{...child,...user, sourceToolAssistantUUID:"assistant",permissionDecision:{decision:"accept"}},
  ]);
  const native = {session_id:attemptId,agent_id:sessionId,subagent_type:"architect",parent_tool_use_id:"spawn"};
  const success = {...native,...user,tool_result_meta:[{id:"tool",permission_decision:{decision:"accept"}}]};
  async function* events(records: Record<string,unknown>[]) {
    for (const [i,value] of records.entries()) yield {kind:"record" as const,line:i+1,value};
  }
  const capture = (...records: Record<string,unknown>[]) => claudeWrites(identity,sb.stateRoot,home,out,sessionId,{startCall:"spawn",events:events(records)});
  expect(await capture({...native,...assistant},success)).toEqual([{...identity,path:"architecture.md",sha256:outputDigest(Buffer.from(content))}]);
  for (const key of ["session_id","agent_id","subagent_type","parent_tool_use_id","uuid"])
    await expect(capture({...native,...assistant},{...success,[key]:"wrong"})).rejects.toThrow("incomplete");
  await expect(capture({...native,...assistant},{...success,tool_result_meta:[{id:"foreign",permission_decision:{decision:"accept"}}]})).rejects.toThrow("incomplete");
  await expect(capture({...native,...assistant})).rejects.toThrow("incomplete");
  await expect(capture({...native,...assistant},{...success,message:{content:[{...response,is_error:true}]}})).rejects.toThrow("incomplete");
  await expect(capture({...native,...assistant},{...success,type:"assistant",message:{content:[{type:"text",text:JSON.stringify(success)}]}})).rejects.toThrow("incomplete");
  const {claudeChildStarts} = await import("../src/dispatch/claude-writes");
  const meta = {sessionId:attemptId,isSidechain:false};
  const start = {...meta,uuid:"parent",type:"assistant",message:{content:[{type:"tool_use",name:"Agent",id:"spawn",input:{subagent_type:"architect"}}]}};
  const launched = {...meta,type:"user",sourceToolAssistantUUID:"parent",message:{content:[{type:"tool_result",tool_use_id:"spawn"}]},
    toolUseResult:{status:"async_launched",agentId:sessionId}};
  const parent = join(project,attemptId + ".jsonl");
  save(parent,[start,launched]);
  expect((await claudeChildStarts(sb.stateRoot,home,attemptId)).get(sessionId)).toEqual({role:"architect",startCall:"spawn",started:1,completed:null});
  save(parent,[start,{...launched,toolUseResult:{...launched.toolUseResult,status:"completed"}}]);
  expect((await claudeChildStarts(sb.stateRoot,home,attemptId)).get(sessionId)?.completed).toBe(2);
  save(parent,[start,{...launched,sourceToolAssistantUUID:"other"}]);
  await expect(claudeChildStarts(sb.stateRoot,home,attemptId)).rejects.toThrow("ambiguous");
});
