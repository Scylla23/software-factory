import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../factory.config";
import { checkoutSnapshot, createAttempt } from "../src/dispatch/attempt";
import { bundleDigest, materializeBundle } from "../src/dispatch/bundle";
import { prepareBroker } from "../src/dispatch/broker";
import { claudeArgs, parseClaudeStream } from "../src/dispatch/claude";
import { claudeWrites } from "../src/dispatch/claude-writes";
import { codexArgs, codexReadable, codexSessionModel, findCodexSessionFile, parseCodexEvents } from "../src/dispatch/codex";
import { codexWrites } from "../src/dispatch/codex-writes";
import { loadDispatchConfig, managedSettingsProblems } from "../src/dispatch/config";
import { runGit } from "../src/dispatch/git";
import { readJsonl } from "../src/dispatch/jsonl";
import { agentEnv, effectiveDenyRead } from "../src/dispatch/policy";
import { assessCleanup, spawnAgentProcess, superviseRun, sweepWorktree } from "../src/dispatch/process";
import { skillPolicy } from "../src/dispatch/skill-policy";
import { Store } from "../src/factory/store";
import { evalCheckout } from "./eval-checkout";
import { prepareVerdict, verifyVerdict } from "./probe-verdict";

const harness = process.argv[2];
if ((harness !== "claude" && harness !== "codex") || process.argv[3] !== "--factory-login") throw new Error("expected a pinned harness and --factory-login");
const dispatch = loadDispatchConfig({agentWriteRoots:[config.workspaceRoot]});
const exe = dispatch.executables[harness];
const version = Bun.spawnSync([exe,"--version"]).stdout.toString().trim();
if (version !== (harness === "claude" ? "2.1.325 (Claude Code)" : "codex-cli 0.169.0") ||
    (harness === "claude" && managedSettingsProblems(dispatch).length)) throw new Error("unverified binary or settings");
const root = mkdtempSync(join(dispatch.accountHome,".factory-proof-"));
const store = new Store(":memory:");
try {
  const state = join(root,"state"), project = join(root,"project");
  for (const dir of [state,project]) mkdirSync(dir,{mode:0o700});
  const git = dispatch.executables.git;
  const factory = join(import.meta.dir,"..");
  const pin = runGit(git,factory,["rev-parse","HEAD"]).toString().trim();
  const refs = evalCheckout(git,factory,pin,project,state,"sort-fix-skips-ac3.patch");
  const task = store.intake({source:"github",repoId:1,issueId:1,number:1,title:"Review",body:"Fixture",sender:1,revision:"1",url:""},refs.base);
  const {id} = store.plan(task,"dispatch-reviewer",{...refs});
  const dirs = createAttempt({role:"code-reviewer",stage:"code",project,accountHome:dispatch.accountHome,
    stateRoot:state,runRoot:join(root,"runs"),attemptId:id});
  for (const cwd of [dirs.worktree,dirs.scratchRepo!]) checkoutSnapshot(git,project,refs.head,cwd);
  const trial = prepareVerdict(git,factory,pin,dirs,refs,String(task.id));
  const broker = prepareBroker(dirs,{...dispatch,stateRoot:state},state,refs.base,refs.head);
  const server = JSON.parse(readFileSync(broker.mcpPath,"utf8")).mcpServers.factory;
  const messages = [
    {id:1,method:"initialize",params:{protocolVersion:"2025-06-18"}},{method:"notifications/initialized"},
    {id:2,method:"tools/call",params:{name:"project_check",arguments:{name:"test"}}},
  ];
  const green = Bun.spawnSync([server.command,...server.args],{cwd:state,env:{},timeout:65_000,
    stdin:Buffer.from(messages.map(m => JSON.stringify({jsonrpc:"2.0",...m})).join("\n") + "\n")});
  if (green.exitCode !== 0) throw new Error("head check did not finish");
  const answer = JSON.parse(green.stdout.toString().trim().split("\n").at(-1)!);
  const checked = JSON.parse(answer.result.content[0].text);
  if (answer.id !== 2 || answer.result.isError || checked.exitCode !== 0 || !/\b7 pass\b/.test(checked.output) || !/\b0 fail\b/.test(checked.output)) throw new Error("head suite did not pass");
  const home = dispatch.harnessHomes[harness];
  const deny = effectiveDenyRead({accountHome:dispatch.accountHome,stateRoot:dispatch.stateRoot,harnessHomes:Object.values(dispatch.harnessHomes)},[state]);
  const policy = skillPolicy(dirs,deny,config.pilot.toolDirs,harness === "codex" ? codexReadable(exe,deny) : [],git);
  const bundle = materializeBundle(git,factory,pin,dirs.skillsDir,[...policy.readable,...policy.writable!]);
  const options = {policy,effort:"low",prompt:"This is a file provenance test. Use the native file submission tool to write exactly these provided bytes, preserving the single trailing newline, to " + trial.output + ". Do not change the supplied document.\n" + trial.authentic.toString()};
  if (harness === "codex") options.prompt = "Use tools.apply_patch to submit a single Add File for " + trial.output + ". The directory already exists. This provenance control checks native FileChange events. Copy the supplied one-line JSON preserving the trailing newline.\n" + trial.authentic.toString();
  const model = harness === "codex" ? "gpt-6-luna" : "haiku";
  const args = harness === "codex" ? codexArgs({...options,model,worktreePath:dirs.worktree}) :
    claudeArgs({...options,model,sessionId:id,fileToolsOnly:true,brokerFile:broker.mcpPath,directories:[dirs.skillsDir,dirs.taskDir,dirs.outDir,dirs.scratchDir]});
  const env = agentEnv(process.env,{harness,harnessHome:home,accountHome:dispatch.accountHome,trustedPath:"/usr/bin:/bin"});
  const stdout = join(state,"agent.jsonl"), out = openSync(stdout,"wx",0o600), err = openSync(join(state,"stderr"),"wx",0o600);
  const proc = (() => {
    try { return spawnAgentProcess({executable:exe,args,cwd:dirs.worktree,env,stdoutFd:out,stderrFd:err,psPath:dispatch.executables.ps}); }
    finally { closeSync(out); closeSync(err); }
  })();
  const run = await superviseRun(proc,{timeoutMs:120_000,psPath:dispatch.executables.ps});
  const swept = await sweepWorktree(dirs.root,{psPath:dispatch.executables.ps,lsofPath:dispatch.executables.lsof});
  if (run.status?.code !== 0 || run.stopped || assessCleanup(run.unverified,swept).quarantineReasons.length) throw new Error("unclean reviewer exit");
  let session: string | null;
  if (harness === "claude") {
    const result = await parseClaudeStream(readJsonl(stdout),{session:id,members:[]});
    if (!result.succeeded || !result.observedModel?.includes("haiku")) throw new Error("wrong Claude session");
    session = result.sessionId;
  } else {
    const result = await parseCodexEvents(readJsonl(stdout));
    session = result.threadId;
    const file = session && await findCodexSessionFile(join(home,"sessions"),session);
    if (!result.succeeded || !file || await codexSessionModel(file) !== model) throw new Error("wrong Codex session");
  }
  if (!session) throw new Error("missing session");
  const receipts = await (harness === "codex" ? codexWrites : claudeWrites)(
    {attemptId:id,taskId:trial.taskId,role:dirs.role,sessionId:session},dispatch.stateRoot,home,dirs.outDir);
  if (bundleDigest(dirs.skillsDir) !== bundle) throw new Error("pinned bundle changed");
  const archived = verifyVerdict(dirs,trial,session,receipts,store,bundle);
  if (!archived) throw new Error("archive or substitution failure");
  console.log(JSON.stringify({harness,version,model,session,id,...refs,headTests:7,archived,hostSubstitutionRejected:true}));
} finally { store.db.close(); rmSync(root,{recursive:true,force:true}); }
