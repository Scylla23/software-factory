/** Cheap, isolated Codex proofs. Each invocation uses one disposable account home per arm. */
import { closeSync, statSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { codexWrites } from "../src/dispatch/codex-writes";
import { outputDigest } from "../src/dispatch/output";
import { codexArgs, codexReadable } from "../src/dispatch/codex";
import { loadDispatchConfig } from "../src/dispatch/config";
import { agentEnv, effectiveDenyRead } from "../src/dispatch/policy";
import { runGit } from "../src/dispatch/git";
import { readJsonl } from "../src/dispatch/jsonl";
import { assessCleanup, spawnAgentProcess, superviseRun, sweepWorktree } from "../src/dispatch/process";
import { createAttempt, checkoutSnapshot } from "../src/dispatch/attempt";
import { skillPolicy } from "../src/dispatch/skill-policy";
import { withCodexProofLogin } from "./proof-credentials";
import { config } from "../factory.config";

const test = process.argv[2];
if (!test || !["A1", "D1", "D2", "write", "R1-shell", "R2", "D3", "A4", "S6"].includes(test)) throw new Error("unknown Codex proof");
const dispatch = loadDispatchConfig({ agentWriteRoots: [config.workspaceRoot] });
const exe = dispatch.executables.codex;
if (Bun.spawnSync([exe, "--version"]).stdout.toString().trim() !== "codex-cli 0.169.0") throw new Error("wrong Codex binary");

async function probe(control: boolean) {
  const root = mkdtempSync(join(userInfo().homedir, ".factory-proof-"));
  try {
    const directory = (name: string) => {
      const path = join(root, name);
      mkdirSync(path, { mode: 0o700 });
      return path;
    };
    const home = directory("account");
    const state = directory("state");
    const repo = directory("source");
    const factoryLogin = process.argv[3] === "--factory-login";
    const run = async (codexHome: string) => {
      const started = Date.now();
      const git = (...args: string[]) => runGit(dispatch.executables.git, repo, args).toString().trim();
      const memberMarker = "CEDAR-" + crypto.randomUUID();
      const definition = `name="probe_member"\ndescription="Disposable factory member"\nmodel="gpt-6-luna"\nmodel_reasoning_effort="low"\ndeveloper_instructions=${JSON.stringify('Your role is <factory_run>{"role":"probe-member"}</factory_run>. Return ' + memberMarker)}\n`;
      git("init", "-q", "--template=");
      writeFileSync(join(repo, "math.test.ts"), 'import { expect, test } from "bun:test";\ntest("factory math", () => expect(2 + 2).toBe(4));\n');
      if (test === "S6") {
        const agents = join(repo, ".codex", "agents");
        mkdirSync(agents, { recursive: true });
        writeFileSync(join(agents, "probe_member.toml"), definition);
      }
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
      const dirs = createAttempt({ role: test === "R2" ? "code-reviewer" : "triage", stage: test === "R2" ? "code" : "triage", attemptId: crypto.randomUUID(), accountHome: home,
        project: repo, runRoot: join(root, "runs"), stateRoot: state });
      checkoutSnapshot(dispatch.executables.git, repo, git("rev-parse", "HEAD"), dirs.worktree);
      if (dirs.scratchRepo) checkoutSnapshot(dispatch.executables.git, repo, git("rev-parse", "HEAD"), dirs.scratchRepo);
      const ownerDeny = effectiveDenyRead({ accountHome: dispatch.accountHome, stateRoot: dispatch.stateRoot, harnessHomes: Object.values(dispatch.harnessHomes) });
      const deny = effectiveDenyRead({ accountHome: home, stateRoot: state, harnessHomes: [codexHome] }, ownerDeny);
      const policy = skillPolicy(dirs, deny, config.pilot.toolDirs, codexReadable(exe, deny), dispatch.executables.git);
      const marker = "MAPLE-" + crypto.randomUUID();
      const resource = join(dirs.skillsDir, "resource.txt");
      const output = join(dirs.outDir, "answer.txt");
      writeFileSync(resource, marker);
      const outside = join(root, "sample.txt");
      writeFileSync(outside, marker);
      const prompts = {
        D3: "Call spawn_agent with agent_type explicitly set to probe_member. The task_name alone does not select the type. Do not call it with any other or missing agent_type. If this call returns an unknown type error, stop. Otherwise wait for the child's reply.",
        S6: "Request spawn_agent with agent_type explicitly set to probe_member. Never use a default type or omit agent_type. Report unavailable if the named type is refused.",
        A4: "Use spawn_agent requesting agent_type default. Wait for this built-in child to return MAPLE.",
        A1: "Use the actual subagent tool to start exactly one default child with your inherited gpt-6-luna model and low effort. Ask it to return MAPLE. Wait for its response. If the tool is unavailable, report unavailable.",
        D1: "Report the instruction marker.",
        D2: `Read the file at ${resource} and return its exact contents.`,
        "R1-shell": `Run /bin/cat "${outside}" exactly once with the shell. Report its exit status.`,
        R2: `Use the shell to execute these four commands individually: cd "${dirs.scratchRepo}" && "${config.pilot.toolDirs[0]}/bun" test ./math.test.ts; git -C "${dirs.worktree}" diff; git -C "${dirs.worktree}" show HEAD:math.test.ts; cat "${resource}". Report the token in the resource.`,
        write: `Using the native patch tool, add ${output} containing exactly PROOF followed by one newline. Stop after the write.`,
      };
      const args = codexArgs({ prompt: prompts[test as keyof typeof prompts], worktreePath: dirs.worktree,
        model: "gpt-6-luna", effort: "low", policy, instructions: test === "D1" ? "Report the instruction marker " + marker + " when asked." : null });
      if (test === "A4" || (test === "D3" && !control)) {
        const defFile = join(state, "member.toml");
        writeFileSync(defFile, definition, { flag: "wx", mode: 0o400 });
        args.splice(args.indexOf("--"), 0, "-c", 'agents.probe_member.description="Disposable factory member"', "-c", "agents.probe_member.config_file=" + JSON.stringify(defFile));
      }
      if (test === "S6" && control) {
        if (factoryLogin) throw new Error("Codex home-source control requires a disposable proof credential");
        const folder = join(codexHome, "agents");
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "probe_member.toml"), definition);
        args.splice(args.indexOf("--ignore-user-config"), 1);
      }
      if ((control && test === "A1") || ["D3","A4","S6"].includes(test!)) args.splice(args.indexOf("agents.enabled=false") - 1, 2);
      if (control && (test === "write" || test === "R1-shell")) {
        const index = args.findIndex(arg => arg.startsWith("permissions="));
        args[index] = args[index]!.replace("factory={filesystem=", 'factory={extends=":workspace",filesystem=').replace('":root"="none",', "");
      }
      const env = agentEnv(process.env, { harness: "codex", trustedPath: "/usr/bin:/bin", accountHome: home, harnessHome: codexHome });
      const stdout = join(state, "stdout.jsonl");
      const stdoutFd = openSync(stdout, "wx", 0o600);
      const stderrFd = openSync(join(state, "stderr.log"), "wx", 0o600);
      const proc = (() => {
        try { return spawnAgentProcess({ executable: exe, args, cwd: dirs.worktree, env, stdoutFd, stderrFd, psPath: dispatch.executables.ps }); }
        finally { closeSync(stdoutFd); closeSync(stderrFd); }
      })();
      const run = await superviseRun(proc, { timeoutMs: 120_000, psPath: dispatch.executables.ps });
      const sweep = await sweepWorktree(root, { psPath: dispatch.executables.ps, lsofPath: dispatch.executables.lsof });
      if (run.status?.code !== 0 || run.stopped || assessCleanup(run.unverified, sweep).quarantineReasons.length)
        throw new Error("probe failed to finish cleanly");
      let final = "", thread = "", nativeStatus = "", observedRead = false;
      let canaryRead: boolean | undefined;
      const commands: string[] = [];
      for await (const line of readJsonl(stdout)) {
        if (line.kind !== "record") throw new Error("invalid harness record");
        const event = line.value;
        if (event.type === "thread.started") thread = String(event.thread_id);
        const item = event.item as Record<string, unknown> | undefined;
        if (event.type !== "item.completed" || !item) continue;
        if (test === "R1-shell" && item.type === "command_execution")
          console.log(JSON.stringify({commandObserved: String(item.command).includes(outside), code: item.exit_code,
            denial: String(item.aggregated_output).replaceAll(marker, "[canary]").slice(-320)}));
        if (item.type === "command_execution") {
          const command = String(item.command);
          if (command.includes(outside) && command.includes("cat")) {
            if (item.exit_code === 0 && String(item.aggregated_output).includes(marker)) canaryRead = true;
            if (item.exit_code === 1 && /Operation not permitted|Permission denied/i.test(String(item.aggregated_output))) canaryRead = false;
          }
          if (item.exit_code === 0) commands.push(command);
        }
        if (item.type === "agent_message") final = String(item.text);
        if (item.type === "command_execution" && String(item.command).includes(resource) && item.exit_code === 0 &&
            String(item.aggregated_output).includes(marker)) observedRead = true;
        if (item.type === "file_change" && Array.isArray(item.changes) && item.changes.some(change => change.path === output))
          nativeStatus = String(item.status);
      }
      if (!thread) throw new Error("missing parent thread");
      const children = new Set<string>();
      const actualChildRoles = new Set<string>();
      let customBody = false, customModel = false, requested = false;
      let sawTools = false, spawnOffered = false, sawSkill = false, observedModel = false;
      for (const file of new Bun.Glob("**/*.jsonl").scanSync(join(codexHome, "sessions"))) {
        let identified = false, parent = false, child = false;
        const sessionPath = join(codexHome, "sessions", file);
        if (factoryLogin && statSync(sessionPath).birthtimeMs < started - 1000) continue;
        for await (const line of readJsonl(sessionPath)) {
          if (line.kind !== "record") throw new Error("invalid session record");
          const { type, payload } = line.value as { type: string; payload: Record<string, any> };
          if (type === "session_meta" && !identified) {
            identified = true;
            parent = payload.id === thread;
            child = payload.source?.subagent?.thread_spawn?.parent_thread_id === thread;
            if (child) { children.add(payload.id); actualChildRoles.add(payload.source.subagent.thread_spawn.agent_role ?? "unspecified"); }
          }
          if (child && type === "response_item" && payload.role === "developer" && payload.type === "message") {
            const body = JSON.stringify(payload.content);
            customBody ||= body.includes(memberMarker) && body.includes("factory_run") && body.includes("probe-member");
          }
          if (child && type === "turn_context") customModel ||= payload.model === "gpt-6-luna" && payload.effort === "low";
          if (!parent) continue;
          if (type === "response_item" && payload.type === "function_call" && payload.name?.endsWith("spawn_agent")) {
            const input = JSON.parse(payload.arguments);
            requested ||= input.agent_type === (test === "A4" ? "default" : "probe_member");
          }
          if (type === "turn_context") observedModel ||= payload.model === "gpt-6-luna" && payload.effort === "low";
          if (type === "response_item" && payload.type === "additional_tools" && Array.isArray(payload.tools)) {
            sawTools = true;
            spawnOffered ||= JSON.stringify(payload.tools).includes('"name":"spawn_agent"');
          }
          if (type === "response_item" && payload.role === "developer" && payload.type === "message")
            sawSkill ||= JSON.stringify(payload.content).includes(marker);
        }
      }
      const exactWrite = await Bun.file(output).exists() && readFileSync(output, "utf8") === "PROOF\n";
      let digestMatched = false;
      if (test === "write") {
        const records = await codexWrites({ taskId: "probe", attemptId: dirs.root.split("/").at(-1)!, sessionId: thread, role: dirs.role }, factoryLogin ? dispatch.stateRoot : state, codexHome, dirs.outDir);
        digestMatched = records.length === 1 && records[0]?.path === "answer.txt" && records[0].sha256 === outputDigest(Buffer.from("PROOF\n"));
      }
      const checks = {
        D3: requested && (control ? !children.size : children.size === 1 && customBody && customModel),
        A4: requested && children.size === 1 && actualChildRoles.has("default") && customModel && !customBody,
        S6: requested && (control ? customBody && customModel : !children.size && !customBody),
        A1: sawTools && spawnOffered === control && children.size === (control ? 1 : 0),
        "R1-shell": canaryRead === control,
        R2: observedRead && final.includes(marker) && commands.some(cmd => cmd.includes(dirs.scratchRepo!) && cmd.includes("test ./math.test.ts")) &&
            ["diff", "show HEAD:math.test.ts"].every(op => commands.some(cmd => cmd.includes(dirs.worktree) && cmd.includes(op))),
        D1: sawSkill && final.includes(marker), D2: observedRead && final.includes(marker), write: exactWrite && digestMatched && nativeStatus === "completed" };
      const passed = observedModel && checks[test as keyof typeof checks];
      console.log(JSON.stringify({ test, control, factoryLogin, thread, children: [...children], observedModel, sawTools, spawnOffered, sawSkill,
        requested, actualChildRoles: [...actualChildRoles], customBody, customModel, observedRead, canaryRead, exactWrite, digestMatched, nativeStatus, passed }));
      return passed;
    };
    return factoryLogin ? await run(dispatch.harnessHomes.codex) : await withCodexProofLogin(exe, state, home, run);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
try {
  let passed = true;
  for (const control of (test === "A1" || test === "write" || test === "D3" || (test === "S6" && process.argv[3] !== "--factory-login") || test === "R1-shell" ? [true, false] : [false])) {
    if (!await probe(control)) passed = false;
  }
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Codex proof failed");
  process.exitCode = 1;
}
