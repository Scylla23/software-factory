import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { config } from "../../factory.config";
import type { AttemptDirectories } from "./attempt";
import { composeInstructions } from "./bundle";
import { MAX_INSTRUCTIONS_BYTES } from "./instructions";
import { readRegularFile } from "./regular-file";

export interface BriefInput {
  /** Validator observations about a rejected submission. Values are untrusted data. */
  validationFeedback?: string;
  taskId: string;
  round: number;
  baseSha: string;
  headSha?: string;
  captureAttemptId?: string;
  specSet?: { sha256: string; files: { name: string; sha256: string }[] };
  project: {
    name: string; isNew: boolean; stack: string; commands: Record<string, string>;
    fixtures: readonly string[]; securityGlobs: readonly string[]; migrationGlobs: readonly string[];
  };
  routing: Record<"S" | "M" | "L", { builder: string; codeReviewer: string }>;
  previous?: {
    decisions?: readonly { member: string; file: string; originalRound: number; authorSession: string; sha256: string }[];
    findings?: readonly { source: string; round: number; path: string }[];
    ownerFeedback?: string; verdict?: string; specSetDir?: string; headSha?: string; buildReport?: string;
  };
}

export function runBrief(dirs: AttemptDirectories, input: BriefInput, teamEnabled = false) {
  if (teamEnabled && dirs.role !== "spec-lead") throw new Error("only the spec lead can run a team");
  if (!input.taskId.trim() || !Number.isSafeInteger(input.round) || input.round < 1 ||
      ![input.baseSha, ...(input.headSha ? [input.headSha] : [])].every(sha => /^[a-f0-9]{40}$/.test(sha)))
    throw new Error("invalid run brief identity");
  return {
    ...input, attemptId: basename(dirs.root), role: dirs.role, stage: dirs.stage,
    worktree: dirs.worktree, taskDir: dirs.taskDir, skillsDir: dirs.skillsDir, outDir: dirs.outDir, scratchDir: dirs.scratchDir,
    ...(dirs.scratchRepo ? { scratchRepo: dirs.scratchRepo } : {}),
    ...(dirs.role === "spec-lead" ? { teamEnabled } : {}),
  };
}

export function briefPrompt(brief: object) {
  const json = JSON.stringify(brief).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `<factory_run>\n${json}\n</factory_run>`;
}

type Member = keyof typeof config.specTeam;
const MEMBERS = Object.keys(config.specTeam) as Member[];
export function requiredMembers(tier: "S" | "M" | "L", security: boolean, newProject: boolean): Member[] {
  return newProject || tier === "L" ? [...MEMBERS] : security ? ["threat-modeler"] : [];
}

/** Build definitions as factory data. Launch authorization remains a separate preflight. */
export function claudeDefinitions(
  brief: ReturnType<typeof runBrief>, members: readonly Member[], projectInstructions: string | null, stagedMemberInputs = false,
) {
  if (brief.role !== "spec-lead" || brief.teamEnabled !== (members.length > 0) || new Set(members).size !== members.length)
    throw new Error("definitions require a matching team-enabled state and distinct members");
  const file = join(brief.skillsDir, "spec-lead/team.json");
  const team = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readRegularFile(file, 32 * 1024)));
  if (team.lead !== "spec-lead" || !Array.isArray(team.members)) throw new Error("invalid spec team definition");
  const definitions: Record<string, { description: string; prompt: string; tools: string[]; model: string; effort: string }> = {
    "spec-lead": {
      description: "Factory spec lead for this attempt",
      prompt: composeInstructions(brief.skillsDir, "spec-lead", projectInstructions),
      tools: [...(members.length ? [`Agent(${members.join(", ")})`] : []), "Read", "Edit", "Write", "Glob", "Grep"],
      model: config.agents.spec.model, effort: config.agents.spec.effort,
    },
  };
  const selected = members.map(name => {
    const matches = team.members.filter((m: { name?: string }) => m.name === name);
    const member = matches[0];
    if (matches.length !== 1 || !Object.hasOwn(config.specTeam, name) || member.skill !== name || member.configRole !== name ||
        typeof member.description !== "string" || !Array.isArray(member.reads) || typeof member.writes !== "string" ||
        ![...member.reads, member.writes].every(path => typeof path === "string" && /^[a-z][a-z-]*\.md$/.test(path)) ||
        !Array.isArray(member.claudeTools) || !member.claudeTools.includes("Write") ||
        !member.claudeTools.includes("Read") || !member.claudeTools.every((tool: string) => ["Read", "Write", "Glob", "Grep"].includes(tool)))
      throw new Error(`invalid specialist definition ${name}`);
    return member as { name: Member; writes: string; reads: string[]; description: string; claudeTools: string[] };
  });
  const outputs = new Set(["team-brief.md", ...selected.map(m => m.writes)]);
  for (const member of selected) {
    const { taskId, attemptId, round, baseSha, worktree, skillsDir, outDir, taskDir, scratchDir, project } = brief;
    const inherited = new Set(brief.previous?.decisions?.map(decision => decision.file) ?? []);
    const child = { taskId, attemptId, round, baseSha, worktree, skillsDir, outDir, taskDir, scratchDir, project,
      role: member.name, parentRole: "spec-lead", stage: "spec",
      reads: stagedMemberInputs ? member.reads.filter(name => existsSync(join(taskDir,name))).map(name => join(taskDir,name))
        : member.reads.filter(name => outputs.has(name) || inherited.has(name)).map(name => join(outputs.has(name) ? outDir : taskDir, name)),
      writes: join(outDir, member.writes) };
    const prompt = composeInstructions(skillsDir, member.name, null) + "\n" + briefPrompt(child) + "\n" + (projectInstructions ?? "");
    if (Buffer.byteLength(prompt) > MAX_INSTRUCTIONS_BYTES) throw new Error("child instructions exceed byte limit");
    definitions[member.name] = {
      description: member.description, tools: member.claudeTools,
      prompt,
      ...config.specTeam[member.name],
    };
  }
  return definitions;
}
