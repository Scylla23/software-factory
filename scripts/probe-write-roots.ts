import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../factory.config";
import { createAttempt, checkoutSnapshot } from "../src/dispatch/attempt";
import { codexConfigArgs, codexReadable } from "../src/dispatch/codex";
import { loadDispatchConfig } from "../src/dispatch/config";
import { runGit } from "../src/dispatch/git";
import { agentEnv, effectiveDenyRead } from "../src/dispatch/policy";
import { skillPolicy } from "../src/dispatch/skill-policy";

const dispatch = loadDispatchConfig({agentWriteRoots: [config.workspaceRoot]});
const exe = dispatch.executables.codex;
if (Bun.spawnSync([exe, "--version"]).stdout.toString().trim() !== "codex-cli 0.169.0") throw new Error("wrong Codex binary");
const root = mkdtempSync(join(dispatch.accountHome, ".factory-probe-"));
try {
  const dir = (name: string) => { const path = join(root,name); mkdirSync(path, {mode: 0o700}); return path; };
  const accountHome = dir("account"), stateRoot = dir("state"), home = dir("codex"), repo = dir("project");
  const git = (...args: string[]) => runGit(dispatch.executables.git,repo,args).toString().trim();
  git("init","--quiet","--template=");
  writeFileSync(join(repo,"example.txt"), "expected\n");
  git("add","example.txt");
  git("-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","fixture");
  const sha = git("rev-parse","HEAD");
  const env = agentEnv(process.env,{harness:"codex",accountHome,harnessHome:home,trustedPath:"/usr/bin:/bin"});
  const ownerDeny = effectiveDenyRead({accountHome:dispatch.accountHome, stateRoot:dispatch.stateRoot, harnessHomes:Object.values(dispatch.harnessHomes)});
  const deny = effectiveDenyRead({accountHome,stateRoot,harnessHomes:[home]},ownerDeny);
  for (const [role,stage] of [
    ["triage","triage"],["builder","build"],["code-reviewer","code"],["database-auditor","code"],["security-auditor","spec"],
    ["security-auditor","code"],["spec-reviewer","spec"],["spec-lead","spec"],["verifier","judge"],
  ] as const) {
    const dirs = createAttempt({accountHome,stateRoot,runRoot:join(root,"runs"),project:repo,attemptId:crypto.randomUUID(),role,stage});
    if (role !== "builder") checkoutSnapshot(dispatch.executables.git,repo,sha,dirs.worktree);
    if (dirs.scratchRepo) checkoutSnapshot(dispatch.executables.git,repo,sha,dirs.scratchRepo);
    const policy = skillPolicy(dirs,deny,config.pilot.toolDirs,codexReadable(exe,deny),dispatch.executables.git);
    const allowed = [dirs.outDir, dirs.scratchDir, ...(dirs.scratchRepo ? [dirs.scratchRepo] : []), ...(role === "builder" ? [repo] : [])];
    const denied = [dirs.skillsDir, dirs.taskDir, join(dirs.worktree,".git"), ...(role === "builder" ? [] : [dirs.worktree,repo])];
    for (const path of denied) writeFileSync(join(path,"factory-probe-existing"), "original");
    const script = [
      "set -eu",
      "allowed() { /usr/bin/touch \"$1/new\" && echo updated > \"$1/new\" && /bin/rm \"$1/new\"; }",
      "denied() { if \"$@\" 2> \"$errors\"; then exit 2; fi; /usr/bin/grep -Eiq 'operation not permitted|permission denied' \"$errors\"; }",
      'errors=$1/errors',
      'shift',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    allowed) allowed "$2" ;;',
      '    denied) denied /usr/bin/touch "$2/factory-probe-new"; denied /bin/mv "$2/factory-probe-existing" "$2/factory-probe-renamed"; denied /bin/rm "$2/factory-probe-existing" ;;',
      '    parent) denied /bin/mv "$2" "$2-elsewhere" ;;',
      '    *) exit 3 ;;',
      '  esac',
      '  shift 2',
      'done',
      "echo verified",
    ].join("\n");
    const run = Bun.spawnSync([exe,"sandbox","-P","factory", ...codexConfigArgs(policy),"--","/bin/sh","-c",script,"proof",dirs.scratchDir,
      ...allowed.flatMap(path => ["allowed",path]), ...denied.flatMap(path => ["denied",path]),
      "parent",dirs.taskDir,"parent",dirs.root],
      {cwd:dirs.worktree,env,timeout:30_000,stdout:"pipe",stderr:"pipe"});
    const passed = run.exitCode === 0 && run.stdout.toString().trim() === "verified";
    console.log(JSON.stringify({role,stage,allowedRoots:allowed.length,deniedRoots:denied.length,passed}));
    if (!passed) process.exitCode = 1;
  }
} finally { rmSync(root,{recursive:true, force:true}); }
