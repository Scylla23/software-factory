import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutSnapshot, createAttempt } from "../src/dispatch/attempt";
import { brokerCommands, BROKER_TOOL, prepareBroker } from "../src/dispatch/broker";
import { runGit } from "../src/dispatch/git";
import { makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => { sb = makeSandbox(); chmodSync(sb.logDir, 0o700); });
afterEach(() => sb.cleanup());

function review() {
  const dirs = createAttempt({
    accountHome: sb.home, stateRoot: sb.stateRoot, runRoot: join(sb.home, "runs"),
    project: sb.worktree, attemptId: crypto.randomUUID(), role: "code-reviewer", stage: "code",
  });
  const git = (...args: string[]) => runGit(sb.config.executables.git, sb.worktree, args).toString().trim();
  git("init", "-q", "--template=");
  writeFileSync(join(sb.worktree, "sum.test.ts"), 'import {test,expect} from "bun:test"; test("sum", () => expect(2 + 2).toBe(4));');
  git("add", "sum.test.ts");
  git("-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","sum");
  const head = git("rev-parse", "HEAD");
  for (const cwd of [dirs.worktree, dirs.scratchRepo!]) checkoutSnapshot(sb.config.executables.git, sb.worktree, head, cwd);
  return {dirs, head};
}

const rpc = (id: number, method: string, params: object = {}) => ({jsonrpc: "2.0", id, method, params});
const init = [
  rpc(1, "initialize", {protocolVersion: "2025-06-18"}),
  {jsonrpc: "2.0", method: "notifications/initialized"},
];
const call = (id: number, args: object) => rpc(id, "tools/call", {name:"project_check", arguments: args});

function session(path: string, requests: object[]) {
  const server = JSON.parse(readFileSync(path, "utf8")).mcpServers.factory;
  const run = Bun.spawnSync([server.command, ...server.args], {
    cwd: sb.worktree, env: { FACTORY_TEST_SECRET: "sentinel" },
    stdin: Buffer.from(requests.map(r => JSON.stringify(r)).join("\n") + "\n"), timeout: 10000,
  });
  expect(run.exitCode).toBe(0);
  return run.stdout.toString().trim().split("\n").map(l => JSON.parse(l));
}

test("restricted broker negotiates MCP and accepts only fixed registered checks on the pinned revisions", () => {
  const {dirs, head} = review();
  expect(() => prepareBroker(dirs, sb.config, dirs.outDir,head,head)).toThrow();
  expect(() => prepareBroker(dirs, sb.config, sb.logDir, "HEAD", head)).toThrow();
  const {mcpPath} = prepareBroker(dirs, sb.config, sb.logDir, head, head);
  const [early, handshake, list, extra, unknown, oversized, result, diff, show] = session(mcpPath, [
    call(0,{name:"test"}), ...init, rpc(2,"tools/list"),
    call(3,{name:"test",cwd: dirs.taskDir}), call(4,{name:"other"}), call(5,{name:"a".repeat(70000)}),
    call(6,{name:"test"}), call(7,{name:"diff"}), call(8,{name:"show"}),
  ]);
  expect(early.error.code).toBe(-32601);
  expect(handshake.result.protocolVersion).toBe("2025-06-18");
  expect(list.result.tools.map((t: {name:string}) => t.name)).toEqual(["project_check"]);
  expect(list.result.tools[0].inputSchema.additionalProperties).toBe(false);
  expect(Object.keys(brokerCommands()).sort()).toEqual(["diff","lint","preview","setup","show","test","typecheck"]);
  expect(brokerCommands().test).toBe(BROKER_TOOL + ' {"name":"test"}');
  expect([extra,unknown].map(r => r.error.code)).toEqual([-32602,-32602]);
  expect(oversized.error.code).toBe(-32700);
  const command = (r: typeof result) => JSON.parse(r.result.content[0].text);
  expect(command(result)).toEqual({exitCode:0,output:expect.stringContaining("(pass) sum")});
  expect(command(diff)).toEqual({exitCode:0,output:""});
  expect(command(show)).toEqual({exitCode:0,output:expect.stringContaining("commit " + head)});
  expect(existsSync(join(sb.logDir, "broker-pending"))).toBe(false);
  writeFileSync(join(sb.logDir, "broker-pending"), "pending");
  const busy = session(mcpPath,[...init,call(2,{name:"test"})]).at(-1);
  expect(busy.result.isError).toBe(true);
  expect(readFileSync(join(sb.logDir,"broker-pending"),"utf8")).toBe("pending");
}, 15000);


test("the review command sandbox preserves ordinary scratch writes and denies nested discovery files", () => {
  const {dirs,head}=review();
  const {manifestPath}=prepareBroker(dirs,sb.config,sb.logDir,head,head);
  const manifest=JSON.parse(readFileSync(manifestPath,"utf8"));
  const parent=join(dirs.scratchRepo!,"fresh");
  mkdirSync(parent);
  const probe=(relative:string)=>Bun.spawnSync([...manifest.prefix,"/usr/bin/touch",join(parent,relative)],{cwd:manifest.cwd,env:manifest.env});
  expect(probe("ordinary.txt").exitCode).toBe(0);
  for(const name of ["AGENTS.override.md","claude.LOCAL.md",".agents",".codex",".Claude"]) {
    const run=probe(name);
    expect(run.stderr.toString()).toContain("Operation not permitted");
    expect(existsSync(join(parent,name))).toBe(false);
  }
});
