import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, inventoryFixture } from "../../factory.config";
import type { AttemptDirectories } from "../dispatch/attempt";
import { requiredMembers, type BriefInput } from "../dispatch/brief";
import { outputDigest } from "../dispatch/output";
import { assertRepoPath } from "../github/commit";
import { Uncertain } from "./machine";
import { acceptedCollections, type Collection } from "./skill-store";
import type { Store, Task } from "./store";

export const skillRoles = { triage: "triage", spec: "spec-lead", builder: "builder", reviewer: "code-reviewer" } as const;
export type WorkerRole = keyof typeof skillRoles;
const specNames = ["architecture.md", "frontend.md", "infra.md", "spec-lead.json", "spec.md", "team-brief.md", "threat-model.md"];
export const expectedFiles = {
  triage: ["triage.json"], spec: ["spec.md", "spec-lead.json"], builder: ["build-report.json"], reviewer: ["verdicts/code-reviewer.json"],
} as const;

export function specFileSet(c: Collection) {
  const files = specNames.flatMap(name => {
    const file = c.files.find(f => f.path === name);
    return file ? [{ name, sha256: file.sha256 }] : [];
  });
  if (!["spec.md", "spec-lead.json"].every(name => files.some(f => f.name === name))) throw new Uncertain("incomplete stored spec collection");
  return { files, sha256: outputDigest(Buffer.from(files.map(f => f.sha256 + "  " + f.name + "\n").join(""))) };
}

/** Freeze everything the supervisor needs before publishing its job. */
export function skillInputs(store: Store, task: Task, role: WorkerRole, context: string) {
  const all = acceptedCollections(store.db, task.id);
  const roleName = skillRoles[role];
  const latest = (name: string) => all.findLast(c => c.role === name);
  const triage = latest("triage"), spec = latest("spec-lead"), build = latest("builder");
  const round = 1 + (latest(roleName)?.round ?? 0);
  const observations = context ? JSON.parse(context) : {};
  const {team, ...stageObservations} = observations;
  const files: Record<string, string> = {};
  const text = (path: string, value: unknown) => { files[path] = Buffer.from(JSON.stringify(value, null, 2) + "\n").toString("base64"); };
  const externalId = config.pilot.owner + "/" + config.pilot.repo + "#" + task.issue.number;
  text("task.json", { source: task.issue.source, externalId, project: config.pilot.repo, kind: "bug", title: task.issue.title,
    body: task.issue.body, attachments: [{ path: "pilot-checks.json" }], sender: String(task.issue.sender), revision: 1 });
  text("pilot-checks.json", { reproduction: { file: "repro.test.ts", criterion: "AC-1", result: "named assertion failure on base and pass on head" },
    fixture: inventoryFixture(task.issue.number), stageObservations });
  const requireCollection = (c: Collection | undefined, name: string) => {
    if (!c || c.base !== task.base) throw new Uncertain("missing validated skill input: " + name);
    for (const f of c.files) files[f.path] = f.base64;
  };
  if (role !== "triage") requireCollection(triage, "triage");
  if (role === "builder" || role === "reviewer" || (role === "spec" && task.spec)) requireCollection(spec, "spec");
  if (role === "reviewer" || (role === "builder" && task.repairCount)) requireCollection(build, "build report");
  for (const c of all) {
    const stage = c.role === "spec-lead" ? "spec" : c.role;
    for (const f of c.files) files[`archive/${stage}/round-${c.round}/${f.path}`] = f.base64;
  }
  const previous: NonNullable<BriefInput["previous"]> = {};
  if (task.reason && (role === "spec" || (role === "builder" && task.repairCount))) {
    const path = `archive/${roleName}/round-${Math.max(1, round - 1)}/feedback.json`;
    text(path, { feedback: task.reason });
    if (role === "spec") previous.ownerFeedback = path;
    else {
      const review = latest("code-reviewer");
      if (review && review.head === task.head) previous.findings = [{ source: "code-reviewer", round: review.round, path: `archive/code-reviewer/round-${review.round}/verdicts/code-reviewer.json` }];
      else previous.findings = [{ source: "checks", round: Math.max(1, round - 1), path }];
    }
  }
  if (role === "builder" && build) {
    previous.buildReport = `archive/builder/round-${build.round}/build-report.json`;
    previous.headSha = task.head;
  }
  const lastReview = latest("code-reviewer");
  if (role === "reviewer" && lastReview) {
    previous.verdict = `archive/code-reviewer/round-${lastReview.round}/verdicts/code-reviewer.json`;
    previous.headSha = lastReview.head;
  }
  const stage = role === "spec" ? "spec" : role === "reviewer" ? "code" : role === "triage" ? "triage" : task.repairCount ? "repair" : "build";
  const criteria = spec && specFileSet(spec);
  const brief: BriefInput = { taskId: String(task.id), round, baseSha: task.base,
    ...(stage === "code" || stage === "repair" ? { headSha: task.head } : {}),
    ...(criteria ? { specSet: criteria } : {}), ...(Object.keys(previous).length ? { previous } : {}),
    project: { name: config.pilot.repo, isNew: false, stack: config.pilot.stack, fixtures: Object.keys(config.pilot.fixtures),
      commands: { setup: config.pilot.commands.setup[0].join(" "), ...Object.fromEntries((["test","lint","typecheck","preview"] as const).map(k => [k, config.pilot.commands[k].join(" ")])) },
      securityGlobs: [], migrationGlobs: [] },
    routing: { S: { builder: "Sol 6.2", codeReviewer: "Opus 5.5" }, M: { builder: "Sonnet 5.5", codeReviewer: "Sol 6.2" }, L: { builder: "Opus 5.5", codeReviewer: "GPT-6.2-Astra" } },
  };
  const triaged = role === "spec" && triage && JSON.parse(Buffer.from(files["triage.json"] ?? "", "base64").toString());
  let members = role === "spec" && triaged ? requiredMembers(triaged.tier, triaged.riskFlags.security.value, brief.project.isNew) : [];
  if (team !== undefined) {
    if (role !== "spec" || !Array.isArray(team) ||
        ![requiredMembers("L",false,false), requiredMembers("M",true,false)].some(allowed => JSON.stringify(allowed) === JSON.stringify(team)) ||
        !members.every(m => team.includes(m))) throw new Uncertain("invalid team handoff");
    members = team;
  }
  return { role: roleName, stage, members, files, brief, inputSha: stage === "repair" || stage === "code" ? task.head : task.base };
}

export function stageInputs(dirs: AttemptDirectories, input: ReturnType<typeof skillInputs>) {
  for (const [relative, base64] of Object.entries(input.files)) {
    assertRepoPath(relative);
    const path = join(dirs.taskDir, relative);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, Buffer.from(base64, "base64"), { flag: "wx", mode: 0o400 });
  }
  if (!input.brief.previous) return input.brief;
  const previous = { ...input.brief.previous };
  for (const key of ["ownerFeedback", "verdict", "buildReport", "specSetDir"] as const)
    if (previous[key]) previous[key] = join(dirs.taskDir, previous[key]!);
  if (previous.findings) previous.findings = previous.findings.map(f => ({ ...f, path: join(dirs.taskDir, f.path) }));
  return { ...input.brief, previous };
}
