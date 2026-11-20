// Serialized factory observations go in the staged task attachments.
// The only user message delivered to a skill is the factory-generated run brief.
import type { Task } from "./store";

export function specPrompt(t: Task) {
  return JSON.stringify({ issueRevision: t.issue.revision, specRevision: t.spec || null });
}
export function buildPrompt(t: Task) {
  return JSON.stringify({ approvedSpec: t.spec, repair: t.repairCount });
}
export function reviewPrompt(t: Task, baseFailure: string, headPass: string) {
  return JSON.stringify({ base: t.base, head: t.head, baseFailure, headPass });
}
