import type { AttemptDirectories } from "./attempt";
import type { BriefInput, requiredMembers } from "./brief";
import { verifiedHomeProof, verifiedTeamModelProof } from "./home-proof";
import type { DispatchConfig } from "./config";
import type { Harness } from "./types";

export interface SkillLaunch {
  dirs: AttemptDirectories;
  brief: BriefInput;
  /** Measure the named Claude lead even when the eval case has no team. */
  namedLeadEvaluation?: true;
  members: ReturnType<typeof requiredMembers>;
  toolDirs: readonly string[];
  factoryRepo: string;
  factoryCommit: string;
}
export class SkillProofMissing extends Error {}

/** Outstanding controls for the pinned binaries are recorded in docs/steps/04b-skills-wiring.md. */
export function requiredProofs(harness: Harness, role: AttemptDirectories["role"], members: readonly string[], stage?: string, dispatch?: DispatchConfig): string[] {
  if (members.length && role !== "spec-lead") return ["only the spec lead may request members"];
  if (members.length && harness === "codex") return ["Codex cannot restrict a lead to its team before dispatch"];

  // S1 covers implicit reads by the harness before any task tool is called.
  // Removing the spawn tool therefore cannot discharge this common control.
  // All skill profiles deny discovery writes, and Claude exposes no direct Bash.
  // Code-stage Claude reviewers run their registered checks through the separate broker.
  const missing = ["S3 system skill discovery"];
  if (!dispatch || !verifiedHomeProof(harness,dispatch.stateRoot,dispatch.executables[harness])) missing.unshift("S1 home skill discovery");
  if (harness === "claude") {
    if (members.length) {
      missing.push("S8 home agent discovery");
      if (!dispatch || !verifiedTeamModelProof(dispatch.stateRoot,dispatch.executables.claude)) missing.push("D3 distinct specialist model and effort");
    }
    if (role === "builder") missing.push("builder command execution with closed reads");
  } else {
    if (["spec-reviewer","database-auditor","code-reviewer"].includes(role)) missing.push("native file tool write-root matrix for " + role);
  }
  if (role === "code-reviewer" || (["security-auditor","database-auditor"].includes(role) && stage === "code"))
    missing.push("R3 project-command substitution");
  return missing;
}

export function requireSkillProofs(harness: Harness, role: AttemptDirectories["role"], members: readonly string[], stage?: string, dispatch?: DispatchConfig) {
  const missing = requiredProofs(harness, role, members, stage, dispatch);
  if (missing.length) throw new SkillProofMissing(harness + " skill dispatch refused: " + missing.join(", "));
}
