import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../factory.config";
import { runAgent } from "../src/dispatch";
import { assertPrivateDir, loadDispatchConfig, type DispatchConfig } from "../src/dispatch/config";
import { runGit } from "../src/dispatch/git";
import { inspectHarnessHome } from "../src/dispatch/home-inventory";
import { afterHomeLaunch, personalSourceNames } from "../src/dispatch/home-session";
import { pinnedVersions } from "../src/dispatch/home-proof";
import type { Harness } from "../src/dispatch/types";

export async function probePersonalSources(harness: Harness, dispatch: DispatchConfig) {
  const {stateRoot,accountHome,executables,harnessHomes} = dispatch;
  const version = Bun.spawnSync([executables[harness],"--version"],{timeout:5000}).stdout.toString().trim();
  if (version !== pinnedVersions[harness]) throw new Error("wrong proof binary");
  const names = personalSourceNames(accountHome);
  if (!names.size) throw new Error("no personal source names to test");
  const root = join(stateRoot,"skill-proofs");
  mkdirSync(root,{mode:0o700,recursive:true});
  assertPrivateDir(root,stateRoot);
  const project = mkdtempSync(join(accountHome,".factory-clean-home-"));
  const id = crypto.randomUUID();
  const logs = join(root,id);
  mkdirSync(logs,{mode:0o700});
  const inventory = inspectHarnessHome(harness,harnessHomes[harness],executables[harness]);
  let retain = false;
  try {
    runGit(executables.git,project,["init","-q","--template="]);
    const model = harness === "claude" ? "claude-haiku-5-5" : "gpt-6-luna";
    const result = await runAgent({runId:id,harness,model,effort:"low",worktreePath:project,readOnlyWorktree:true,
      prompt:"Reply MAPLE without calling a tool.",instructions:null,logDir:logs,timeoutMs:90000},dispatch);
    retain = result.quarantineWorktree || !result.noKnownSurvivors;
    const failures = [...result.diagnostics];
    if (!failures.length) {
      try { await afterHomeLaunch(harness,harnessHomes[harness],inventory,result.stdoutPath,result.sessionId,{personal:names}); }
      catch (error) { failures.push((error as Error).message); retain=true; }
    }
    const passed = !failures.length && !retain && result.outcome === "completed" && result.observedModel === model && result.resultText?.trim() === "MAPLE";
    const receipt = {harness,version,test:"personal-negative",id,session:result.sessionId,model:result.observedModel,effort:"low",
      scope:"installed-sources",candidates:names.size,disabledNames:inventory.names.size,passed,failures,usage:result.usage};
    writeFileSync(join(logs,"result.json"),JSON.stringify(receipt),{flag:"wx",mode:0o600});
    if (passed) {
      const path=join(root,id+".json");
      writeFileSync(path,JSON.stringify(receipt),{flag:"wx",mode:0o600});
      renameSync(path,join(root,harness+"-personal-negative.json"));
    }
    return receipt;
  } finally { if (!retain) rmSync(project,{recursive:true,force:true}); }
}

if (import.meta.main) {
  const h=process.argv[2];
  if (h!=="claude" && h!=="codex") throw new Error("select claude or codex");
  const receipt=await probePersonalSources(h,loadDispatchConfig({agentWriteRoots:[config.workspaceRoot]}));
  console.log(JSON.stringify(receipt));
  if(!receipt.passed) process.exitCode=1;
}
