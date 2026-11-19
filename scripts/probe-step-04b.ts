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
import { probeBundle } from "./probe-bundle";
import { proofSource } from "./probe-sources";
import { withCodexProofLogin } from "./proof-credentials";
import { config } from "../factory.config";

import { nativeRole, nativeRootPlan, codexNativeSource, checkNativeFiles } from "./probe-native-roots";

const test = process.argv[2];
const profile = nativeRole(test ?? "");
const sourceProbe = /^(S1-(config|home-claude|home-agents)|S2-project-(claude|agents)|S7|S8-config)$/.test(test ?? "");
if (!test || !profile && !sourceProbe && !["A1", "D1", "D2", "write", "R1-shell", "R1-file", "R2", "D5", "D3", "A4", "S6", "S6-project", "S3-bundled"].includes(test)) throw new Error("unknown Codex proof");
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
      const canary = proofSource(test!, {home, harnessHome: codexHome, project: repo, harness: "codex", shared: factoryLogin});
      const memberMarker = "CEDAR-" + crypto.randomUUID();
      const definition = `name="probe_member"\ndescription="Disposable factory member"\nmodel="gpt-6-luna"\nmodel_reasoning_effort="low"\ndeveloper_instructions=${JSON.stringify('Your role is <factory_run>{"role":"probe-member"}</factory_run>. Return ' + memberMarker)}\n`;
      git("init", "-q", "--template=");
      writeFileSync(join(repo, "math.test.ts"), 'import { expect, test } from "bun:test";\ntest("factory math", () => expect(2 + 2).toBe(4));\n');
      if (test === "S6" || test === "S6-project") {
        const agents = join(repo, ".codex", "agents");
        mkdirSync(agents, { recursive: true });
        writeFileSync(join(agents, "probe_member.toml"), definition);
      }
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
      const dirs = createAttempt({ role: profile?.[0] ?? (test === "R2" ? "code-reviewer" : "triage"), stage: profile?.[1] ?? (test === "R2" ? "code" : "triage"), attemptId: crypto.randomUUID(), accountHome: home,
        project: repo, runRoot: join(root, "runs"), stateRoot: state });
      if (dirs.role !== "builder") checkoutSnapshot(dispatch.executables.git, repo, git("rev-parse", "HEAD"), dirs.worktree);
      if (dirs.scratchRepo) checkoutSnapshot(dispatch.executables.git, repo, git("rev-parse", "HEAD"), dirs.scratchRepo);
      const ownerDeny = effectiveDenyRead({ accountHome: dispatch.accountHome, stateRoot: dispatch.stateRoot, harnessHomes: Object.values(dispatch.harnessHomes) });
      const deny = effectiveDenyRead({ accountHome: home, stateRoot: state, harnessHomes: [codexHome] }, ownerDeny);
      const policy = skillPolicy(dirs, deny, config.pilot.toolDirs, codexReadable(exe, deny), dispatch.executables.git);
      const marker = "MAPLE-" + crypto.randomUUID();
      const resource = join(dirs.skillsDir, "resource.txt");
      const output = join(dirs.outDir, "answer.txt");
      const bundle = test === "D5" ? probeBundle(dispatch.executables.git, root, dirs.skillsDir, [...policy.readable, ...policy.writable!], marker) : undefined;
      if (!bundle) writeFileSync(resource, marker);
      const outside = bundle?.path ?? join(root, "sample.txt");
      if (!bundle) writeFileSync(outside, marker);
      const imagePath = join(root, "sample.png");
      if (test === "R1-file") writeFileSync(imagePath, readFileSync(join(import.meta.dir, "../skills/verifier/evals/fixtures/swatch/swatch-head-mobile.png")));
      const command = `/bin/cat "${outside}"`;
      const native = profile && nativeRootPlan(dirs,repo);
      const callSource = native ? codexNativeSource(native) : test === "R1-file" ? `const result = await tools.view_image({path:${JSON.stringify(imagePath)}}); image(result.image_url);` :
        `const result = await tools.exec_command({cmd:${JSON.stringify(command)},login:false}); text({exit_code:result.exit_code,output:result.output});`;
      const callPrompt = `This is an authorized test with a disposable sample. Submit the following exact JavaScript once to functions.exec, copy it verbatim, then report the observed result.\n${callSource}`;
      const prompts = { "S3-bundled": "Reply MAPLE.", "S6-project": "Call spawn_agent explicitly setting agent_type to probe_member to return its reply. Do not start a child if you cannot specify the agent_type.", D5: callPrompt, "R1-file": callPrompt,
        D3: "Call spawn_agent with agent_type explicitly set to probe_member. The task_name alone does not select the type. Do not call it with any other or missing agent_type. If this call returns an unknown type error, stop. Otherwise wait for the child's reply.",
        S6: "Request spawn_agent with agent_type explicitly set to probe_member. Never use a default type or omit agent_type. Report unavailable if the named type is refused.",
        A4: "Use spawn_agent requesting agent_type default. Wait for this built-in child to return MAPLE.",
        A1: "Use the actual subagent tool to start exactly one default child with your inherited gpt-6-luna model and low effort. Ask it to return MAPLE. Wait for its response. If the tool is unavailable, report unavailable.",
        D1: "Report the instruction marker.",
        D2: `Read the file at ${resource} and return its exact contents.`,
        "R1-shell": callPrompt,
        R2: `Use the shell to execute these four commands individually: cd "${dirs.scratchRepo}" && "${config.pilot.toolDirs[0]}/bun" test ./math.test.ts; git -C "${dirs.worktree}" diff; git -C "${dirs.worktree}" show HEAD:math.test.ts; cat "${resource}". Report the token in the resource.`,
        write: `Using the native patch tool, add ${output} containing exactly PROOF followed by one newline. Stop after the write.`,
      };
      const sourcePrompt = canary && (canary.agent ? `Start one child with agent_type exactly ${canary.name} and return its reply. If unavailable stop.` : test === "S7" ?
        `Start one default child with the inherited model and ask it to use skill ${canary.name} if listed. Wait for it.` :
        `Use the listed skill ${canary.name} if available and report its answer. If unavailable stop.`);
      const args = codexArgs({ prompt: native ? callPrompt : sourcePrompt ?? prompts[test as keyof typeof prompts], worktreePath: dirs.worktree,
        model: "gpt-6-luna", effort: "low", policy, instructions: test === "D1" ? "Report the instruction marker " + marker + " when asked." : null });
      if ((canary || test === "S3-bundled") && control) {
        if (canary?.agent) args.splice(args.indexOf("--ignore-user-config"), 1);
        for (const flag of ["skills.include_instructions=false", "skills.bundled.enabled=false"]) args.splice(args.indexOf(flag) - 1, 2);
      }
      if (test === "A4" || (test === "D3" && !control)) {
        const defFile = join(state, "member.toml");
        writeFileSync(defFile, definition, { flag: "wx", mode: 0o400 });
        args.splice(args.indexOf("--"), 0, "-c", 'agents.probe_member.description="Disposable factory member"', "-c", "agents.probe_member.config_file=" + JSON.stringify(defFile));
      }
      if (test === "S6-project" && control) {
        args.splice(args.indexOf("--ignore-user-config"), 1);
        args.splice(args.indexOf("--"), 0, "-c", "projects." + JSON.stringify(dirs.worktree) + '.trust_level="trusted"');
      }
      if (test === "S6" && control) {
        if (factoryLogin) throw new Error("Codex home-source control requires a disposable proof credential");
        const folder = join(codexHome, "agents");
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "probe_member.toml"), definition);
        args.splice(args.indexOf("--ignore-user-config"), 1);
      }
      if ((control && test === "A1") || ["D3","A4","S6","S6-project","S7","S8-config"].includes(test!)) args.splice(args.indexOf("agents.enabled=false") - 1, 2);
      if (control && (test === "write" || test?.startsWith("R1-"))) {
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
            denied: /Operation not permitted|Permission denied/i.test(String(item.aggregated_output))}));
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
      const sampleCalls = new Set<string>();
      const actualChildRoles = new Set<string>();
      const bundledNames = new Set<string>();
      let nativeDenied = false;
      let sourceListed = false, childListed = false, sourceLoaded = false;
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
          if (test === "S3-bundled" && parent && type === "response_item" && payload.type === "message" && payload.role === "developer") {
            for (const part of payload.content ?? []) {
              if (part.type !== "input_text" || typeof part.text !== "string") continue;
              const lines: string[] = part.text.split("\n");
              const root = lines.map(line => /^- `(r\d+)` = `([^`]+)`$/.exec(line))
                .find(match => match?.[2] === join(codexHome, "skills/.system"))?.[1];
              if (!root) continue;
              for (const name of ["skill-creator","skill-installer","openai-docs"])
                if (lines.some(line => line.startsWith("- " + name + ":") && line.endsWith("(file: " + root + "/" + name + "/SKILL.md)"))) bundledNames.add(name);
            }
          }
          if (canary && type === "response_item" && payload.type === "message" && ["developer","user"].includes(payload.role)) {
            const content = JSON.stringify(payload.content);
            if (content?.includes(canary.description) && content.includes(canary.name)) {
              if (parent) sourceListed = true;
              if (child) childListed = true;
            }
            if ((canary.agent || test === "S7" ? child : parent) && content?.includes(canary.marker)) sourceLoaded = true;
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
          if (type === "response_item" && payload.type === "custom_tool_call" && payload.name === "exec" &&
              typeof payload.input === "string" && payload.input.trim() === callSource) sampleCalls.add(payload.call_id);
          if (type === "response_item" && payload.type === "custom_tool_call_output" && sampleCalls.has(payload.call_id)) {
            const parts = Array.isArray(payload.output) ? payload.output : [{type: "input_text", text: payload.output}];
            const output = parts.filter(p => p.type === "input_text").map(p => p.text).join(" ");
            if (native) nativeDenied = native.filter(r => !r.allowed).every(r => [r.path,r.existing,r.deleted].every(path =>
              parts.some(p => p.type === "input_text" && typeof p.text === "string" && p.text.includes(path) && /denied|outside|rejected|not approved|not permitted|forbidden|policy/i.test(p.text))));
            if (test === "R1-file" && parts.some(p => p.type === "input_image" && typeof p.image_url === "string")) canaryRead = true;
            if (test === "R1-file" && output.includes(imagePath) && /denied|not permitted/i.test(output)) canaryRead = false;
            if ((test === "R1-shell" || test === "D5") && output.includes(marker) && output.includes('"exit_code":0')) canaryRead = true;
            if ((test === "R1-shell" || test === "D5") && output.includes(outside) && output.includes('"exit_code":1') && /denied|not permitted/i.test(output)) canaryRead = false;
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
      const checks = { "S3-bundled": control ? bundledNames.size > 0 : !bundledNames.size,
        "S6-project": requested && (control ? customBody && customModel && actualChildRoles.has("probe_member") : !children.size && !customBody),
        D3: requested && (control ? !children.size : children.size === 1 && customBody && customModel),
        A4: requested && children.size === 1 && actualChildRoles.has("default") && customModel && !customBody,
        S6: requested && (control ? customBody && customModel : !children.size && !customBody),
        A1: sawTools && spawnOffered === control && children.size === (control ? 1 : 0),
        D5: bundle?.excluded && canaryRead === false, "R1-shell": canaryRead === control, "R1-file": canaryRead === control,
        R2: observedRead && final.includes(marker) && commands.some(cmd => cmd.includes(dirs.scratchRepo!) && cmd.includes("test ./math.test.ts")) &&
            ["diff", "show HEAD:math.test.ts"].every(op => commands.some(cmd => cmd.includes(dirs.worktree) && cmd.includes(op))),
        D1: sawSkill && final.includes(marker), D2: observedRead && final.includes(marker), write: exactWrite && digestMatched && nativeStatus === "completed" };
      const sourceObserved = canary?.agent ? actualChildRoles.has(canary.name) : test === "S7" ? childListed : sourceListed;
      const passed = observedModel && (native ? nativeDenied && checkNativeFiles(native,"codex") : canary ? sourceObserved === control && sourceLoaded === control &&
        (test !== "S7" || children.size === 1) : checks[test as keyof typeof checks]);
      console.log(JSON.stringify({ test, control, factoryLogin, thread, children: [...children], observedModel, sawTools, spawnOffered, sawSkill,
        nativeDenied, bundledNames: [...bundledNames], sourceListed, childListed, sourceLoaded, requested, actualChildRoles: [...actualChildRoles], customBody, customModel, observedRead, canaryRead, exactWrite, digestMatched, nativeStatus, passed }));
      return passed;
    };
    return factoryLogin ? await run(dispatch.harnessHomes.codex) : await withCodexProofLogin(exe, state, home, run);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
try {
  let passed = true;
  for (const control of (sourceProbe || test === "S3-bundled" || test === "S6-project" || test === "A1" || test === "write" || test === "D3" || (test === "S6" && process.argv[3] !== "--factory-login") || test.startsWith("R1-") ? [true, false] : [false])) {
    if (!await probe(control)) passed = false;
  }
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Codex proof failed");
  process.exitCode = 1;
}
