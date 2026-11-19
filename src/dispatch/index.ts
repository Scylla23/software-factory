import { sessionUuid } from "./validation";
import { closeSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { claudeArgs, parseClaudeStream } from "./claude";
import { codexArgs, codexReadable, codexSessionModel, findCodexSessionFile, parseCodexEvents } from "./codex";
import { assertPrivateDir, assertSafeDir, assertStateRootIsolated, type DispatchConfig, isUnder, managedSettingsProblems, planRunFiles, reserveRunFiles, tempRoots, trustedAgentPath } from "./config";
import { prepareBroker } from "./broker";
import { briefPrompt, claudeDefinitions, runBrief } from "./brief";
import { bundleDigest, composeInstructions, materializeBundle } from "./bundle";
import { requireSkillProofs, type SkillLaunch } from "./skill-launch";
import { skillPolicy } from "./skill-policy";
import { buildProjectInstructions } from "./instructions";
import { readJsonl } from "./jsonl";
import { openRunMonitor, type RunMonitor } from "../orca/monitor";
import { gitWriteProtectedPaths } from "./git";
import { agentEnv, assertPolicySound, assertWorktreeWritable, effectiveDenyRead, type PolicyContext, type SandboxPolicy } from "./policy";
import { type AgentProcess, assessCleanup, spawnAgentProcess, superviseRun, sweepWorktree } from "./process";
import type { RunOutcome, RunResult, RunSpec } from "./types";

export { loadDispatchConfig, type DispatchConfig } from "./config";
export type { RunResult, RunSpec } from "./types";

const AGENT_LABEL = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Runs one headless agent turn in a worktree and waits for it.
 * stdout goes straight to a log file so the raw stream survives a factory crash; logs are kept.
 * Throws only before anything starts (bad spec, aborted signal, unsafe config or log location).
 */
export async function runAgent(spec: RunSpec, config: DispatchConfig): Promise<RunResult> {
  if (!sessionUuid.test(spec.runId)) throw new Error(`runId must be a lowercase UUID: ${spec.runId}`);
  if (spec.monitor && !AGENT_LABEL.test(spec.monitor.agent)) throw new Error(`monitor agent label must match ${AGENT_LABEL}: ${JSON.stringify(spec.monitor.agent)}`);
  spec.signal?.throwIfAborted();
  const worktree = realpathSync(spec.worktreePath);
  const executable = config.executables[spec.harness];
  let realExecutable: string | null = null;
  try {
    realExecutable = realpathSync(executable);
  } catch {
    // a missing executable surfaces as a failed spawn below
  }
  if (realExecutable && isUnder(realExecutable, worktree)) throw new Error(`executable ${realExecutable} is inside the worktree`);
  if (spec.harness === "claude") {
    const problems = managedSettingsProblems(config);
    if (problems.length > 0) throw new Error(`refusing Claude dispatch, managed settings would apply:\n${problems.join("\n")}`);
  }
  const skill = spec.skill;
  if (skill) {
    if (skill.dirs.worktree !== worktree || basename(skill.dirs.root) !== spec.runId) throw new Error("skill attempt or worktree mismatch");
    requireSkillProofs(spec.harness, skill.dirs.role, skill.members);
  }
  const ctx: PolicyContext = { accountHome: config.accountHome, stateRoot: config.stateRoot, harnessHomes: Object.values(config.harnessHomes) };
  const denyRead = effectiveDenyRead(ctx, spec.extraDenyRead);
  const binaryRoots = spec.harness === "codex" && realExecutable ? codexReadable(realExecutable, denyRead) : [];
  const policy: SandboxPolicy = skill ? skillPolicy(skill.dirs, denyRead, skill.toolDirs, binaryRoots, config.executables.git) : {
    denyRead,
    readable: binaryRoots,
    denyWrite: [...gitWriteProtectedPaths(config.executables.git, worktree), ...(spec.readOnlyWorktree ? [worktree] : [])],
  };
  assertPolicySound(policy, ctx);
  if (skill ? skill.dirs.role === "builder" : !spec.readOnlyWorktree) assertWorktreeWritable(policy, worktree);
  const agentWritable = policy.writable ?? [worktree, ...tempRoots()];
  assertStateRootIsolated(config.stateRoot, [...agentWritable, ...policy.readable]);
  assertSafeDir(config.stateRoot, config.accountHome);
  const projectInstructions = spec.instructions ? buildProjectInstructions(spec.instructions, config.executables.git, agentWritable) : null;
  const bundleHash = skill ? materializeBundle(config.executables.git, skill.factoryRepo, skill.factoryCommit, skill.dirs.skillsDir,
    [...policy.readable, ...agentWritable]) : undefined;
  const instructions = skill ? composeInstructions(skill.dirs.skillsDir, skill.dirs.role, projectInstructions) : projectInstructions;
  const fileToolsOnly = !!skill && spec.harness === "claude";
  const broker = fileToolsOnly && skill.dirs.scratchRepo ? prepareBroker(skill.dirs, config, spec.logDir, skill.brief.baseSha, skill.brief.headSha!) : undefined;
  const brief = skill ? runBrief(skill.dirs, skill.brief, skill.members.length > 0) : undefined;

  const prompt = brief ? briefPrompt(brief) : spec.prompt;
  const home = assertPrivateDir(config.harnessHomes[spec.harness], config.stateRoot);
  const path = skill ? trustedAgentPath([...skill.toolDirs, "/Library/Developer/CommandLineTools/usr/bin"], agentWritable) : config.agentPath;
  const env = agentEnv(process.env, { harness: spec.harness, harnessHome: home, trustedPath: path, accountHome: config.accountHome });
  const files = planRunFiles(config, spec.logDir, spec.runId, agentWritable);
  const instructionsPath = instructions === null ? null : files.instructionsPath;
  const team = skill && brief && skill.members.length ? publishTeam(skill, brief, projectInstructions, fileToolsOnly) : undefined;
  if (team) env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = "1";
  const args =
    spec.harness === "claude"
      ? claudeArgs({ prompt, model: spec.model, effort: spec.effort, sessionId: spec.runId, policy, instructionsFile: team ? null : instructionsPath, team, fileToolsOnly, brokerFile:broker?.mcpPath, directories: skill && [skill.dirs.taskDir, skill.dirs.skillsDir, skill.dirs.outDir, skill.dirs.scratchDir] })
      : codexArgs({ prompt, model: spec.model, effort: spec.effort, worktreePath: worktree, policy, instructions });

  // Reserve private log files before starting the harness.
  const logs = reserveRunFiles(files, instructions);
  let proc: AgentProcess;
  try {
    proc = spawnAgentProcess({ executable, args, cwd: worktree, env, stdoutFd: logs.stdoutFd, stderrFd: logs.stderrFd, psPath: config.executables.ps });
  } finally {
    closeSync(logs.stdoutFd);
    closeSync(logs.stderrFd);
  }

  let monitor: RunMonitor | null = null;
  if (spec.monitor) {
    monitor = openRunMonitor({ orcaPath: config.executables.orca, worktreePath: worktree, title: `factory: ${spec.monitor.agent} ${spec.runId}`, attemptId: spec.runId, logPath: logs.stdoutPath });
  }

  const { status, stopped, cleanup, unverified } = await superviseRun(proc, { timeoutMs: spec.timeoutMs, signal: spec.signal, psPath: config.executables.ps });

  const diagnostics: string[] = [];
  // The monitor closes first: its tab is the owner's, not the run's, though the sweep would skip it anyway.
  if (monitor) diagnostics.push(...(await monitor.close()).map((d) => `monitor: ${d}`));
  if (status?.error) diagnostics.push(`spawn failed: ${status.error}`);
  // Anything still running in the worktree now outlived the run, wherever it sits in the process tree.
  const sweepRoots = skill ? [skill.dirs.root, ...(skill.dirs.role === "builder" ? [worktree] : [])] : [worktree];
  const quarantineReasons: string[] = [];
  let noKnownSurvivors = true;
  for (const root of sweepRoots) {
    const sweep = await sweepWorktree(root, { psPath: config.executables.ps, lsofPath: config.executables.lsof });
    const verdict = assessCleanup(unverified, sweep);
    noKnownSurvivors &&= verdict.noKnownSurvivors;
    quarantineReasons.push(...verdict.quarantineReasons.filter(reason => !quarantineReasons.includes(reason)));
  }
  if (broker && existsSync(join(spec.logDir,"broker-pending"))) quarantineReasons.push("broker command cleanup requires inspection");
  if (skill && bundleHash) {
    try { if (bundleDigest(skill.dirs.skillsDir) !== bundleHash) throw new Error("digest mismatch"); }
    catch { quarantineReasons.push("pinned skill bundle changed during the run"); }
  }
  diagnostics.push(...quarantineReasons.map((r) => `quarantine: ${r}`));
  const outcome = (succeeded: boolean): RunOutcome => stopped ?? (status?.code === 0 && succeeded ? "completed" : "failed");
  const base = {
    harness: spec.harness,
    ...(bundleHash ? { bundleHash } : {}),
    runId: spec.runId,
    exitCode: status?.code ?? null,
    signalCode: status?.signal ?? null,
    requestedModel: spec.model,
    stdoutPath: logs.stdoutPath,
    stderrPath: logs.stderrPath,
    instructionsPath,
    cleanup,
    noKnownSurvivors,
    quarantineWorktree: quarantineReasons.length > 0,
    quarantineReasons,
  };

  if (spec.harness === "claude") {
    const s = await parseClaudeStream(readJsonl(logs.stdoutPath), skill && {session: spec.runId, members: skill.members});
    return {
      ...base,
      sessionId: s.sessionId,
      outcome: outcome(s.succeeded),
      observedModel: s.observedModel,
      usage: s.usage,
      ...(s.reportedCostUsd === undefined ? {} : { reportedCostUsd: s.reportedCostUsd }),
      resultText: s.resultText,
      diagnostics: [...diagnostics, ...s.diagnostics],
    };
  }
  const s = await parseCodexEvents(readJsonl(logs.stdoutPath));
  diagnostics.push(...s.diagnostics);
  return {
    ...base,
    sessionId: s.threadId,
    outcome: outcome(s.succeeded),
    observedModel: s.threadId ? await observedCodexModel(join(home, "sessions"), s.threadId, diagnostics) : null,
    usage: s.usage,
    resultText: s.resultText,
    diagnostics,
  };
}

/** The observed model is evidence, not the outcome: failures here only make it unknown. */
async function observedCodexModel(root: string, threadId: string, diagnostics: string[]): Promise<string | null> {
  try {
    const file = await findCodexSessionFile(root, threadId);
    if (!file) {
      diagnostics.push(`observed model unknown: no rollout for thread ${threadId}`);
      return null;
    }
    const model = await codexSessionModel(file);
    if (!model) diagnostics.push(`observed model unknown: no turn_context model in ${file}`);
    return model;
  } catch (err) {
    diagnostics.push(`observed model unknown: ${(err as Error).message}`);
    return null;
  }
}

function publishTeam(skill: SkillLaunch, brief: ReturnType<typeof runBrief>, projectInstructions: string | null, fileToolsOnly: boolean) {
  if (!skill.dirs.agentsDir) throw new Error("spec lead lacks its private definitions directory");
  const file = join(skill.dirs.agentsDir, "definitions.json");
  const definitions = claudeDefinitions(brief, skill.members, projectInstructions);
  if (fileToolsOnly) definitions["spec-lead"]!.tools = definitions["spec-lead"]!.tools.filter(tool => tool !== "Bash");
  writeFileSync(file, JSON.stringify(definitions), { flag: "wx", mode: 0o400 });
  return { file, members: skill.members };
}
