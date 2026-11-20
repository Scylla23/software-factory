import type { AttemptDirectories } from "./attempt";
import type { BriefInput, requiredMembers } from "./brief";
import { verifiedNativeRoots, verifiedPersonalProbe } from "./home-proof";
import type { DispatchConfig } from "./config";
import type { Harness } from "./types";

export interface SkillLaunch {
  dirs: AttemptDirectories;
  brief: BriefInput;
  /** Measure the named Claude lead even when the eval case has no team. */
  namedLeadEvaluation?: true;
  /** A standalone specialist eval uses its production child system prompt with read-only staged inputs. */
  evaluationMember?: ReturnType<typeof requiredMembers>[number];
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

  const missing: string[] = [];
  if (!dispatch || !verifiedPersonalProbe(harness,dispatch.stateRoot,dispatch.executables[harness])) missing.push("factory personal-source probe");
  if (harness === "claude") {
    if (role === "builder") missing.push("builder command execution with closed reads");
  } else {
    if (["spec-reviewer","database-auditor","code-reviewer"].includes(role) &&
        (!dispatch || !verifiedNativeRoots(dispatch.stateRoot, dispatch.executables.codex, role, stage)))
      missing.push("native file tool write-root matrix for " + role);
  }
  return missing;
}

export function requireSkillProofs(harness: Harness, role: AttemptDirectories["role"], members: readonly string[], stage?: string, dispatch?: DispatchConfig) {
  const missing = requiredProofs(harness, role, members, stage, dispatch);
  if (missing.length) throw new SkillProofMissing(harness + " skill dispatch refused: " + missing.join(", "));
}
