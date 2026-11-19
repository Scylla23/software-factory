import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../factory.config";
import { createAttempt, checkoutSnapshot } from "../src/dispatch/attempt";
import { claudeWrites } from "../src/dispatch/claude-writes";
import { outputDigest } from "../src/dispatch/output";
import { claudeArgs } from "../src/dispatch/claude";
import { loadDispatchConfig, managedSettingsProblems } from "../src/dispatch/config";
import { runGit } from "../src/dispatch/git";
import { agentEnv, effectiveDenyRead } from "../src/dispatch/policy";
import { skillPolicy } from "../src/dispatch/skill-policy";
import { runClaudeProof } from "./proof-credentials";

const selected = process.argv[2];
if (!selected || !["D1", "D2", "write", "A1", "A2", "A3"].includes(selected)) throw new Error("pass D1, D2, write, A1, A2 or A3");
const shared = process.argv[3] === "--factory-login";
const dispatch = loadDispatchConfig({ agentWriteRoots: [config.workspaceRoot] });
const exe = dispatch.executables.claude;
if (Bun.spawnSync([exe, "--version"]).stdout.toString().trim() !== "2.1.325 (Claude Code)" || managedSettingsProblems(dispatch).length)
  throw new Error("wrong Claude binary or managed settings present");

async function arm(control: boolean) {
  const root = mkdtempSync(join(dispatch.accountHome, ".factory-proof-"));
  try {
    const make = (name: string) => { const p = join(root, name); mkdirSync(p, { mode: 0o700 }); return p; };
    const state = make("state");
    const home = shared ? dispatch.accountHome : make("home");
    const harnessHome = shared ? dispatch.harnessHomes.claude : make("claude");
    const source = make("source");
    const git = (...args: string[]) => runGit(dispatch.executables.git, source, args).toString().trim();
    git("init", "-q", "--template=");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
    const id = crypto.randomUUID();
    const dirs = createAttempt({ role: "spec-lead", stage: "spec", attemptId: id, accountHome: dispatch.accountHome,
      runRoot: join(root, "runs"), stateRoot: state, project: source });
    checkoutSnapshot(dispatch.executables.git, source, git("rev-parse", "HEAD"), dirs.worktree);
    const deny = effectiveDenyRead({ accountHome: dispatch.accountHome, stateRoot: dispatch.stateRoot, harnessHomes: Object.values(dispatch.harnessHomes) }, [state, harnessHome]);
    const policy = skillPolicy(dirs, deny, config.pilot.toolDirs, [], dispatch.executables.git);
    const marker = "LARCH-" + crypto.randomUUID();
    const childMarker = "BIRCH-" + crypto.randomUUID();
    const file = join(dirs.skillsDir, "resource.txt");
    writeFileSync(file, marker);
    const output = join(dirs.outDir, "answer.txt");
    const team = selected === "A2" || selected === "A3" || selected === "D1";
    const prompts = {
      D1: "Report the marker in your spec-lead instructions.",
      D2: `Use Read to read ${file} and report its contents.`,
      write: `Using Write, create ${output} with exactly PROOF and one newline.`,
      A1: "Start exactly one general-purpose subagent. Ask it to reply MAPLE. Report when it completes or if the tool is unavailable.",
      A2: control ? "Start probe-other and report its reply." : "Request probe-member, probe-other, Explore, Plan, general-purpose, and fork, each by name, to return MAPLE. Report which requests were available.",
      A3: "Start probe-member and ask it to start one general-purpose child to return MAPLE.",
    };
    const args = claudeArgs({ prompt: prompts[selected as keyof typeof prompts], model: "haiku", effort: "low", sessionId: id, policy,
      directories: [dirs.taskDir, dirs.skillsDir, dirs.outDir, dirs.scratchDir] });
    if (team || (selected === "A1" && control)) args[args.indexOf("--tools") + 1] += ",Agent";
    if (team) {
      const definitions = {
        "spec-lead": { description: "Factory probe lead", prompt: "The spec-lead marker is " + marker,
          tools: [control && selected === "A2" ? "Agent" : "Agent(probe-member)", "Read", "Write"], model: "haiku", effort: "low" },
        "probe-member": { description: "Factory probe member", prompt: selected === "A3" ? "Ask one general-purpose subagent to reply MAPLE if you have the Agent tool. Then report your result." : "Return " + childMarker,
          tools: selected === "A3" && control ? ["Read", "Agent"] : ["Read"], model: "haiku", effort: "low" },
        "probe-other": { description: "Unlisted proof member", prompt: "Return FIR", tools: ["Read"], model: "haiku", effort: "low" },
      };
      const path = join(dirs.agentsDir!, "definitions.json");
      writeFileSync(path, JSON.stringify(definitions), { flag: "wx", mode: 0o400 });
      args.splice(args.indexOf("--"), 0, "--agents", path, "--agent", "spec-lead");
    }
    let result: { status: number | null; stdout: string };
    if (shared) {
      const env = agentEnv(process.env, { harness: "claude", harnessHome, accountHome: home, trustedPath: "/usr/bin:/bin" });
      env.CLAUDE_CODE_SUBAGENT_MODEL = "haiku";
      env.CLAUDE_CODE_EFFORT_LEVEL = "low";
      if (!(selected === "A3" && control)) env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = "1";
      const child = spawnSync(exe, args, { env, cwd: dirs.worktree, stdio: ["ignore", "pipe", "ignore"], timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL" });
      result = { status: child.status, stdout: child.stdout?.toString("utf8") ?? "" };
    } else {
      result = runClaudeProof(exe, args, dirs.worktree, home, harnessHome, "/usr/bin/security", !(selected === "A3" && control));
    }
    const events = result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const init = events.find(e => e.type === "system" && e.subtype === "init" && e.session_id === id);
    const final = events.find(e => e.type === "result" && e.session_id === id && !e.is_error && e.subtype === "success");
    const tools: string[] = init?.tools ?? [];
    const agentTool = tools.some(name => /^(Agent|Task)(?:\(|$)/.test(name));
    const uses = events.flatMap(e => e.type === "assistant" && Array.isArray(e.message?.content) ?
      e.message.content.filter((c: { type: string }) => c.type === "tool_use") : []);
    const read = uses.find(c => c.name === "Read" && c.input.file_path === file);
    const readResult = read && events.some(e => e.type === "user" && e.message.content.some((c: Record<string, unknown>) =>
      c.type === "tool_result" && c.tool_use_id === read.id && c.is_error !== true && JSON.stringify(c.content).includes(marker)));
    const write = uses.find(c => c.name === "Write" && c.input.file_path === output && c.input.content === "PROOF\n");
    const written = write && events.some(e => e.type === "user" && e.message.content.some((c: Record<string, unknown>) =>
      c.type === "tool_result" && c.tool_use_id === write.id && c.is_error !== true)) && readFileSync(output, "utf8") === "PROOF\n";
    const types = uses.filter(c => c.name === "Agent").map(c => c.input?.subagent_type);
    const childTranscripts = [...new Bun.Glob(`projects/*/${id}/subagents/**/agent-*.jsonl`).scanSync(harnessHome)];
    const children = childTranscripts.map(path => {
      const lines = readFileSync(join(harnessHome, path), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
      return { agent: lines.find(l => l.agentId)?.agentId ?? null, model: lines.find(l => l.type === "assistant")?.message?.model,
        memberMarker: lines.some(l => l.type === "assistant" && JSON.stringify(l.message.content).includes(childMarker)) };
    });
    const roots = [...new Bun.Glob(`projects/*/${id}.jsonl`).scanSync(harnessHome)];
    const parent = roots.length === 1 ? readFileSync(join(harnessHome, roots[0]!), "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
    const starts = parent.filter(e => e.sessionId === id && e.type === "user" && e.toolUseResult?.agentId && e.toolUseResult?.agentType)
      .map(e => ({ role: e.toolUseResult.agentType, id: e.toolUseResult.agentId }));
    const childTools = childTranscripts.flatMap(path => readFileSync(join(harnessHome, path), "utf8").trim().split("\n").map(l => JSON.parse(l))
      .filter(e => e.type === "api-request-shape" && Array.isArray(e.shape?.tools)).map(e => e.shape.tools.map((t: {name: string}) => t.name)));
    const matched = starts.every(start => children.some(child => child.agent === start.id));
    const digests = selected === "write" ? await claudeWrites({ taskId: "probe", attemptId: id, sessionId: id, role: dirs.role },
      shared ? dispatch.stateRoot : root, harnessHome, dirs.outDir) : [];
    const digestMatched = digests.length === 1 && digests[0]?.sha256 === outputDigest(Buffer.from("PROOF\n"));
    const checks = { D1: parent.some(e => e.type === "api-request-shape" && JSON.stringify(e.shape?.system).includes(marker)) && String(final?.result).includes(marker),
      D2: Boolean(readResult) && String(final?.result).includes(marker), write: Boolean(written) && digestMatched,
      A1: Array.isArray(init?.tools) && agentTool === control && children.length === (control ? 1 : 0),
      // A requested start is insufficient to prove absence or the child's effective tools.
      A2: control ? matched && starts.some(s => s.role === "probe-other") :
        matched && starts.length === 1 && children.length === 1 && starts[0]?.role === "probe-member" &&
        ["probe-other", "Explore", "Plan", "general-purpose", "fork"].every(name => types.includes(name)),
      A3: matched && starts.some(s => s.role === "probe-member") && (control ? children.length > 1 :
        children.length === 1 && childTools.length > 0 && childTools.every(ts => !ts.some((name: string) => /^(Task|Agent)$/.test(name)))) };
    const passed = Boolean(result.status === 0 && init && /haiku/i.test(init.model) && final && checks[selected as keyof typeof checks]);
    console.log(JSON.stringify({ test: selected, control, factoryLogin: shared, id, status: result.status, observedModel: init?.model,
      toolAgent: agentTool, exposedTools: tools, types, children, starts, childTools, delivered: String(final?.result).includes(marker), observedRead: Boolean(readResult), digestMatched, written: Boolean(written), passed }));
    return passed;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
try {
  let passed = true;
  for (const control of selected.startsWith("A") ? [true, false] : [false]) if (!await arm(control)) passed = false;
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Claude proof failed");
  process.exitCode = 1;
}
