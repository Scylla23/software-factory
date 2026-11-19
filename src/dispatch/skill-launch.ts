import type { AttemptDirectories } from "./attempt";
import type { BriefInput, requiredMembers } from "./brief";
import type { Harness } from "./types";

export interface SkillLaunch {
  dirs: AttemptDirectories;
  brief: BriefInput;
  members: ReturnType<typeof requiredMembers>;
  toolDirs: readonly string[];
  factoryRepo: string;
  factoryCommit: string;
}
export class SkillProofMissing extends Error {}

/** The evidence in docs/steps/04b-skills-wiring.md is for pinned binaries and particular surfaces. */
export function requireSkillProofs(harness: Harness, role: AttemptDirectories["role"], members: readonly string[]) {
  if (members.length && role !== "spec-lead") throw new SkillProofMissing("only the spec lead may request members");
  if (members.length && harness === "codex") throw new SkillProofMissing("Codex cannot restrict a lead to its team before dispatch");
  throw new SkillProofMissing(`${harness} skill dispatch refused: closed reads, write roots, discovery and output integrity require completed live controls`);
}
