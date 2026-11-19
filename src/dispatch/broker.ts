import { closeSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { config } from "../../factory.config";
import type { AttemptDirectories } from "./attempt";
import { assertPrivateDir, trustedAgentPath, type DispatchConfig } from "./config";
import { gitWriteProtectedPaths } from "./git";
import { isRecord, parseJsonl } from "./jsonl";
import { effectiveDenyRead } from "./policy";
import { assessCleanup, spawnAgentProcess, superviseRun, sweepWorktree } from "./process";
import { readRegularFile } from "./regular-file";
import { copyCapped, tail } from "../verify/preview";
import { projectEnv, sandboxArgv } from "../verify/sandbox";

export const BROKER_TOOL = "mcp__factory__project_check";
const checks = ["test","lint","typecheck","diff","show"] as const;
type Operation = typeof checks[number];

export function brokerCommands(): Record<string, string> {
  return {
    ...Object.fromEntries(checks.map(name => [name, BROKER_TOOL + " " + JSON.stringify({name})])),
    setup: "Prepared by the factory before dispatch",
    preview: "Factory verification stage",
  };
}
interface Manifest {
  cwd: string; logDir: string; prefix: string[]; env: Record<string,string>;
  commands: Record<Operation, readonly string[]>; ps: string; lsof: string;
}

/** Freeze canonical Seatbelt parameters while the factory still owns the pristine checkout. */
export function prepareBroker(dirs: AttemptDirectories, dispatch: DispatchConfig, logDir: string, base: string, head: string) {
  if (!dirs.scratchRepo || realpathSync(dirs.scratchRepo) !== join(dirs.scratchDir,"repo") ||
      ![base,head].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error("invalid broker checkout");
  assertPrivateDir(logDir, dispatch.stateRoot);
  const home = join(dirs.scratchRepo, ".factory-command-" + crypto.randomUUID());
  mkdirSync(home, {mode:0o700});
  mkdirSync(join(home,"tmp"), {mode:0o700});
  const denyRead = effectiveDenyRead({accountHome:dispatch.accountHome,stateRoot:dispatch.stateRoot,harnessHomes:Object.values(dispatch.harnessHomes)});
  const gitDirs = [dirs.worktree,dirs.scratchRepo].flatMap(tree => gitWriteProtectedPaths(dispatch.executables.git,tree));
  const policy = {writable:[dirs.scratchRepo], readable:[dirs.worktree,...gitDirs,...config.pilot.toolDirs.map(p => realpathSync(p))],
    denyWrite:[dirs.worktree,...gitDirs],denyRead,network:{kind:"none" as const}};
  const prefix = sandboxArgv("/usr/bin/sandbox-exec",policy,["/bin/true"]).slice(0,-1);
  const { test,lint,typecheck } = config.pilot.commands;
  const git = [dispatch.executables.git,"--no-pager","-C",dirs.worktree];
  const manifest: Manifest = {cwd: dirs.scratchRepo,logDir,prefix,
    env:projectEnv({home,path:trustedAgentPath(config.pilot.toolDirs,[dirs.root]),user:userInfo().username}),
    commands:{test, lint, typecheck, diff:[...git,"diff","--no-ext-diff",base,head],show:[...git,"show","--no-ext-diff","--stat",head]},
    ps:dispatch.executables.ps,lsof:dispatch.executables.lsof};
  const manifestPath = join(logDir, "broker.json"), mcpPath = join(logDir, "broker-mcp.json");
  writeFileSync(manifestPath,JSON.stringify(manifest),{flag:"wx",mode:0o400});
  // Start Bun in a protected directory, away from project-controlled startup files.
  const args = ["-i","PATH=/usr/bin:/bin","/bin/sh","-c",'cd "$1" && exec "$2" "$3" "$4"',"broker",
    logDir,realpathSync(process.execPath),import.meta.path,manifestPath];
  writeFileSync(mcpPath,JSON.stringify({mcpServers:{factory:{type:"stdio",command:"/usr/bin/env",args}}}),{flag:"wx",mode:0o400});
  return {mcpPath,manifestPath};
}

async function runCheck(m: Manifest, name: Operation) {
  const pending = join(m.logDir, "broker-pending");
  writeFileSync(pending, name, {flag: "wx", mode: 0o600});
  const log = join(m.logDir,"broker-command-" + crypto.randomUUID() + ".log");
  const fd = openSync(log,"wx",0o600);
  let proc;
  try {
    proc = spawnAgentProcess({executable:m.prefix[0]!,args:[...m.prefix.slice(1),...m.commands[name]],
      cwd:m.cwd,env:m.env,stdoutFd:"pipe",stderrFd:"pipe",psPath:m.ps});
  } catch (e) { closeSync(fd); throw e; }
  const output = copyCapped([proc.stdout!,proc.stderr!],fd,1024 * 1024);
  try {
    const run = await superviseRun(proc,{timeoutMs:60_000,psPath:m.ps});
    const sweep = await sweepWorktree(m.cwd,{psPath:m.ps,lsofPath:m.lsof});
    const {quarantineReasons} = assessCleanup(run.unverified,sweep);
    if (run.stopped || run.status?.error || quarantineReasons.length) {
      throw new Error("project command stopped or its cleanup requires inspection");
    }
    const drained = await Promise.race([output.done.then(() => true), Bun.sleep(750).then(() => false)]);
    if (!drained) throw new Error("command output remained open after cleanup");
    unlinkSync(pending);
    return {exitCode:run.status?.code ?? null,output:tail(log,8000)};
  } finally { output.close(); }
}

export async function serveBroker(manifestPath: string) {
  const m: Manifest = JSON.parse(readRegularFile(manifestPath,64*1024).toString());
  let initialized = false, ready = false;
  const send = (id: unknown, body: object) => process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,...body}) + "\n");
  for await (const item of parseJsonl(Bun.stdin.stream(), 64 * 1024)) {
    if (item.kind === "invalid") {
      send(null, {error: {code: -32700, message: "invalid JSON request"}});
      continue;
    }
    const msg = item.value;
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") { send(null,{error:{code:-32600,message:"invalid request"}}); continue; }
    if (msg.method === "notifications/initialized" && initialized && msg.id === undefined) { ready = true; continue; }
    if (msg.id === undefined) continue;
    if (typeof msg.id !== "string" && typeof msg.id !== "number") { send(null,{error:{code:-32600,message:"invalid request id"}}); continue; }
    let result: unknown;
    if (msg.method === "initialize" && !initialized && isRecord(msg.params)) {
      initialized = true;
      const version = msg.params.protocolVersion;
      result = {protocolVersion:["2025-11-25","2025-06-18","2025-03-26"].includes(String(version)) ? version : "2025-11-25",
        capabilities:{tools:{}},serverInfo:{name:"factory-project-check",version:"1"}};
    } else if (msg.method === "ping") result = {};
    else if (ready && msg.method === "tools/list") result = {tools:[{name:"project_check",description:"Run a registered check in the disposable review checkout or inspect its pinned revisions.",
      inputSchema:{type:"object",properties:{name:{type:"string",enum:checks}},required:["name"],additionalProperties:false}}]};
    else if (ready && msg.method === "tools/call") {
      const params = msg.params;
      const args = isRecord(params) && params.arguments;
      if (!isRecord(params) || params.name !== "project_check" || !isRecord(args) || Object.keys(args).length !== 1 || !checks.includes(args.name as Operation)) {
        send(msg.id,{error:{code:-32602,message:"expected one registered operation name"}}); continue;
      }
      try {
        const command = await runCheck(m,args.name as Operation);
        result = {isError:command.exitCode !== 0,content:[{type:"text",text:JSON.stringify(command)}]};
      } catch { result = {isError:true,content:[{type:"text",text:"Factory project check failed. See the protected command log."}]}; }
    } else { send(msg.id,{error:{code:-32601,message:"method unavailable"}}); continue; }
    send(msg.id,{result});
  }
}
if (import.meta.main) await serveBroker(process.argv[2] ?? "");
