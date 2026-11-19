import { Database } from "bun:sqlite";
import { join } from "node:path";
import { config } from "../../factory.config";
import { assertPrivateDir } from "../dispatch/config";
import { Publisher, issueNumber } from "./github";
import { headDecision, pendingRevision, pendingResume, pendingReverification, pendingSpec, type Review } from "./gates";
import { buildPrompt, reviewPrompt, specPrompt } from "./prompts";
import { checkAbandonedPreviews, ProjectChecks, requireHealthyInfrastructure } from "./checks";
import { verdict, check, type Check } from "../verify/verdict";
import { fenced, redact, type EvidenceSummary } from "../github/summary";
import { collectFeedback } from "../usage/feedback";
import { verifyPilot } from "./verify";
import { Store, type Attempt, type Task } from "./store";
import { dispatchWorker, protectsChecks, WorkerLoginError, type WorkerOutput } from "./worker";

import { loadDispatchConfig } from "../dispatch/config";
import { requiredMembers } from "../dispatch/brief";
import { requireSkillProofs, SkillProofMissing } from "../dispatch/skill-launch";
import { InvalidSkillOutput } from "./skill-validation";
import { drive, effect, Uncertain } from "./machine";

export type Observer = (event: string, id: string) => void;
type StagePublisher = Pick<Publisher, "boundPull" | "fetch" | "commit" | "draft" | "comment" | "comments" | "pages" |
  "ready" | "reviewBoundary" | "basePaths" | "reproduction" | "summary">;
interface Services {
  git: StagePublisher;
  stateRoot: string;
  test: ProjectChecks["test"];
  verify: (task: Task, attempt: Attempt, prior: Check[]) => Promise<EvidenceSummary>;
  dispatch: typeof dispatchWorker;
  authorizeTeam?: typeof requireSkillProofs;
  observe: Observer;
}

function submittedText(output: WorkerOutput, path: string) {
  const file = output.collection?.files.find(f => f.path === path);
  if (!file) throw new Uncertain("missing authenticated skill output " + path);
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file.base64, "base64"));
}

async function skillEffect<T>(store: Store, task: Task, action: string, intent: unknown, execute: (a: Attempt) => Promise<T>) {
  try { return await effect(store, task, action, intent, execute); }
  catch (error) { if (!(error instanceof InvalidSkillOutput)) throw error; }
  try { return await effect(store, task, action + "-validation-retry", intent, execute); }
  catch (error) {
    if (!(error instanceof InvalidSkillOutput)) throw error;
    throw new Uncertain("skill output failed validation twice: " + error.message);
  }
}
function repair(store: Store, task: Task, reason: string) {
  if (task.repairCount) return store.move(task, "escalated", { reason });
  return store.move(task, "building", { reason, repairCount: 1 });
}

async function build(store: Store, task: Task, { git, dispatch, test, observe }: Services) {
  const approved = store.db
    .query("SELECT id FROM approvals WHERE task=? AND kind='comment' AND accepted=1 AND sha=?")
    .get(task.id, task.spec);
  if (!approved) throw new Error("spec has no owner approval");
  const prompt = buildPrompt(task);
  const files = await skillEffect(store, task, "dispatch-builder", { base: task.base, head: task.head, prompt }, async (a) => {
    await git.boundPull(task);
    await git.fetch(task.head);
    const output = await dispatch(store, task, a, "builder", prompt, observe);
    submittedText(output, "build-report.json");
    return output.files;
  });
  const protectedFile = files.find((f) => protectsChecks(f.path));
  if (protectedFile) return store.move(task, "escalated", { reason: `builder changed check configuration: ${protectedFile.path}` });
  const repro = files.find((f) => f.path === "repro.test.ts");
  if ((!repro || files.length === 0) && !task.repairCount)
    return store.move(task, "failed", { reason: "builder omitted repro.test.ts" });
  const existing = git.basePaths(task.base);
  if (files.some((f) => existing.has(f.path) && /(?:^|\/)(?:test|tests)\/|\.(?:spec|test)\.[a-z]+$/.test(f.path)))
    return store.move(task, "escalated", { reason: "builder changed an existing test" });
  const content =
    repro?.content ?? git.reproduction(task.head);
  const proof = await effect(store, task, "base-reproduction", { base: task.base, content }, (a) =>
    test(task, a, content),
  );
  requireHealthyInfrastructure(proof.checks);
  if (!verdict(proof.checks).pass)
    return store.move(task, "escalated", {
      reason: `base did not reproduce the named regression: ${verdict(proof.checks).failed.join(", ")}`,
    });
  const head = files.length
    ? await effect(store, task, "commit-fix", { parent: task.head, files }, (a) =>
        git.commit(
          task,
          a.id,
          `fix: ${task.issue.title}`,
          files.map((f) => ({ path: f.path, content: Buffer.from(f.content, "base64") })),
          task.head,
        ),
      )
    : task.head;
  return store.move(task, "checks", { head });
}

async function checks(store: Store, task: Task, { git, test }: Services) {
  await git.boundPull(task);
  const result = await effect(store, task, "head-checks", { base: task.base, head: task.head }, async (a) => {
    await git.fetch(task.head);
    return test(task, a);
  });
  requireHealthyInfrastructure(result.checks);
  const v = verdict(result.checks);
  return v.pass ? store.move(task, "code_review") : repair(store, task, `failed head checks: ${v.failed.join(", ")}`);
}

export function reviewVerdict(text: string) {
  const parsed: unknown = JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/, "$1"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("verdict" in parsed) ||
    !["approve", "changes"].includes(String(parsed.verdict)) ||
    !("rationale" in parsed) ||
    typeof parsed.rationale !== "string" ||
    !parsed.rationale.trim() ||
    parsed.rationale.length > 8000
  )
    throw new Error("invalid reviewer verdict");
  return { verdict: parsed.verdict as "approve" | "changes", rationale: parsed.rationale };
}

async function review(store: Store, task: Task, { git, dispatch, observe }: Services) {
  if (String(config.agents.builder.harness) === config.agents.reviewer.harness)
    throw new Error("review must use the opposite vendor");
  const observation = (action: string, name: string, revision: string) => {
    const evidence = latest<{ tested: string; checks: Check[] }>(store, task, action);
    const proof = evidence.checks.find((c) => c.name === name && c.pass);
    if (evidence.tested !== revision || !proof) throw new Error("missing reviewed reproduction evidence");
    return redact(proof.detail, 8_000);
  };
  const prompt = reviewPrompt(task, observation("base-reproduction", "AC-1 fails on base", task.base),
    observation("head-checks", "AC-1 passes on head", task.head));
  const result = await skillEffect(store, task, "code-review", { base: task.base, head: task.head, prompt }, async (a) => {
    await git.boundPull(task);
    const output = await dispatch(store, task, a, "reviewer", prompt, observe);
    const submitted = JSON.parse(submittedText(output, "verdicts/code-reviewer.json"));
    return { base: task.base, head: task.head, ...reviewVerdict(JSON.stringify({ verdict: submitted.verdict, rationale: submitted.summary })) };
  });
  return result.verdict === "approve" ? store.move(task, "verifying") : repair(store, task, result.rationale);
}

function latest<T>(store: Store, task: Task, action: string): T {
  const row = store.db
    .query<{ result: string }, [number, string]>(
      "SELECT result FROM attempts WHERE task=? AND action IN (?2,?2 || '-validation-retry') AND result IS NOT NULL ORDER BY visit DESC LIMIT 1",
    )
    .get(task.id, action);
  if (!row) throw new Error(`missing required evidence: ${action}`);
  return JSON.parse(row.result);
}
export function afterVerification(store: Store, task: Task, evidence: EvidenceSummary) {
  if (task.state !== "verifying" || evidence.pr !== task.pr || evidence.head !== task.head || evidence.base !== task.base)
    throw new Error("verification evidence does not match the task revisions");
  requireHealthyInfrastructure(evidence.checks);
  const v = verdict(evidence.checks);
  if (!v.pass) return repair(store, task, `failed verification: ${v.failed.join(", ")}`);
  return store.move(task, "awaiting_pr_approval");
}

async function verify(store: Store, task: Task, services: Services) {
  await services.git.boundPull(task);
  const before = latest<{ base: string; tested: string; checks: Check[] }>(store, task, "base-reproduction");
  const after = latest<{ base: string; head: string; tested: string; checks: Check[] }>(store, task, "head-checks");
  const review = latest<{ base: string; head: string; verdict: string; rationale: string }>(store, task, "code-review");
  if (
    before.tested !== task.base ||
    after.tested !== task.head ||
    after.base !== task.base ||
    review.base !== task.base ||
    review.head !== task.head ||
    review.verdict !== "approve"
  )
    throw new Error("check or review revisions moved");
  const prior = [
    ...before.checks.map((c) => ({ ...c, name: `base ${c.name}` })),
    ...after.checks.map((c) => ({ ...c, name: `head ${c.name}` })),
    check("opposite vendor code review", true, review.rationale),
  ];
  const evidence = await effect(store, task, "verify", { base: task.base, head: task.head }, (a) =>
    services.verify(task, a, prior),
  );
  return afterVerification(store, task, evidence);
}

async function gateTwo(store: Store, git: StagePublisher, task: Task) {
  await git.boundPull(task);
  const evidence = latest<EvidenceSummary>(store, task, "verify");
  if (evidence.base !== task.base || evidence.head !== task.head || !verdict(evidence.checks).pass)
    throw new Error("missing verification of current head");
  const comment = await effect(store, task, "publish-evidence", { pr: task.pr, attempt: evidence.attemptId }, () =>
    git.summary(evidence),
  );
  store.db.run("INSERT OR IGNORE INTO factory_comments VALUES(?,?)", [comment.id, task.id]);
  const ready = await effect<string | true>(store, task, "mark-ready", { pr: task.pr, head: task.head }, async () => {
    await git.ready(task);
    return git.reviewBoundary(task, comment.id);
  });
  const pull = await git.boundPull(task);
  if (pull.draft) throw new Error("PR is still a draft");
  console.log(`Approve PR #${task.pr} at ${task.head} ${pull.htmlUrl}`);
  const readyAt = ready === true ? await git.reviewBoundary(task, comment.id) : ready;
  const reviews = await git.pages<Review>(`/pulls/${task.pr}/reviews`);
  const decision = headDecision(task, reviews, readyAt);
  let next: Task | null = null;
  if (decision?.accepted) {
    await git.boundPull(task);
    next = store.move(task, "done", {}, decision);
  } else if (decision) {
    store.record(task.id, decision);
  }
  await collectFeedback(store.db, task, reviews, signal => git.pages(`/pulls/${task.pr}/comments`, signal));
  return next;
}

async function resolveVerification(store: Store, git: StagePublisher, task: Task, stateRoot: string) {
  const interrupted = store.interrupted(task);
  if (interrupted) {
    await git.boundPull(task);
    const id = await effect(store, task, "report-interruption", { pr: task.pr, attempt: interrupted.id }, (a) =>
      git.comment(task.pr, a.id, `Read-only attempt \`${interrupted.id}\` stopped without a receipt. Confirm its previews, leases and browser profile are closed, then post \`/resume ${interrupted.id}\` for a fresh attempt on this head.`));
    store.db.run("INSERT OR IGNORE INTO factory_comments VALUES(?,?)", [id, task.id]);
    const comments = await git.comments(task.pr);
    await git.boundPull(task);
    const event = pendingResume(store, task, comments, id, interrupted.id);
    if (!event) return null;
    checkAbandonedPreviews(stateRoot, interrupted.id);
    return store.move(task, interrupted.state, { reason: interrupted.reason }, event);
  }
  if (!store.canReverify(task)) {
    if (task.pr) {
      const id = await effect(store, task, "report-escalation", { pr: task.pr, reason: task.reason }, (a) =>
        git.comment(task.pr, a.id, `Factory task ${task.id} requires owner attention.\n\n${fenced(redact(task.reason))}`));
      store.db.run("INSERT OR IGNORE INTO factory_comments VALUES(?,?)", [id, task.id]);
    }
    return null;
  }
  await git.boundPull(task);
  const command = `/reverify ${task.head}`;
  const id = await effect(
    store,
    task,
    "report-verification-escalation",
    { pr: task.pr, head: task.head, reason: task.reason },
    (a) =>
      git.comment(
        task.pr,
        a.id,
        `Verification escalated. ${task.reason}. After resolving the cause, the owner may request a fresh capture of this head with \`${command}\`.`,
      ),
  );
  store.db.run("INSERT OR IGNORE INTO factory_comments VALUES(?,?)", [id, task.id]);
  const comments = await git.comments(task.pr);
  const pull = await git.boundPull(task);
  return store.db.transaction(() => {
    const resolution = pendingReverification(store, task, comments, id, pull.headSha);
    return resolution ? store.move(task, "verifying", { reason: "owner requested fresh evidence" }, resolution) : null;
  })();
}

class TeamHandoff extends Error {
  constructor(readonly members: ReturnType<typeof requiredMembers>) { super("team required"); }
}
function parseHandoff(text: string) {
  const tier = /\btier\s*[:=]?\s*([SML])\b/i.exec(text)?.[1]?.toUpperCase() as "S" | "M" | "L" | undefined;
  if (!tier) throw new Uncertain("spec team required: ambiguous confirmed tier");
  const members = requiredMembers(tier, /\bsecurity\b/i.test(text), false);
  if (!members.length || !members.every(m => text.includes(m))) throw new Uncertain("spec team required: incomplete specialist list");
  return members;
}
async function draft(store: Store, task: Task, { git, dispatch, observe, authorizeTeam = requireSkillProofs }: Services) {
  if (!task.spec) {
    await skillEffect(store, task, "dispatch-triage", { base: task.base, revision: task.issue.revision }, async a => {
      await git.fetch(task.base);
      const output = await dispatch(store, task, a, "triage", "{}", observe);
      submittedText(output, "triage.json");
      return a.id;
    });
  }
  const prompt = specPrompt(task);
  const writeSpec = (action: string, team: ReturnType<typeof requiredMembers> = []) => {
    const context = team.length ? JSON.stringify({...JSON.parse(prompt), team}) : prompt;
    return skillEffect(store, task, action, { head: task.head, prompt: context }, async (a) => {
      await git.fetch(task.head);
      const output = await dispatch(store, task, a, "spec", context, observe);
      const text = output.result.resultText?.trim() ?? "";
      if (text.startsWith("BLOCKED: team required")) {
        if (team.length) throw new Uncertain("spec team required again after fresh team launch");
        throw new TeamHandoff(parseHandoff(text.slice(0, 1000)));
      }
      if (text.startsWith("BLOCKED: ")) throw new Uncertain("spec lead blocked: " + text.slice(9, 609));
      const spec = submittedText(output, "spec.md");
      if (!spec.includes("AC-1") || spec.length > 32_000) throw new InvalidSkillOutput("invalid spec writer output");
      return spec;
    });
  };
  let spec: string;
  try {
    try { spec = await writeSpec("dispatch-spec"); }
    catch (e) {
      if (!(e instanceof WorkerLoginError)) throw e;
      spec = await writeSpec("dispatch-spec-after-login");
    }
  } catch (e) {
    if (!(e instanceof TeamHandoff)) throw e;
    try { authorizeTeam(config.agents.spec.harness, "spec-lead", e.members); }
    catch (denied) {
      if (!(denied instanceof SkillProofMissing)) throw denied;
      throw new Uncertain("spec team required but no proven team-capable launch is available: " + denied.message);
    }
    spec = await writeSpec("dispatch-spec-with-team", e.members);
  }
  const head = await effect(store, task, "commit-spec", { head: task.head, spec }, (a) =>
    git.commit(
      task,
      a.id,
      `docs: specify issue #${task.issue.number}`,
      [{ path: `docs/specs/issue-${task.issue.number}.md`, content: Buffer.from(spec) }],
      task.pr ? task.head : null,
    ),
  );
  const pr =
    task.pr ||
    (await effect(store, task, "open-draft", { head, base: task.base }, async (a) => {
      const number = await git.draft(task, a.id, head);
      observe("draft-open", a.id);
      return number;
    }));
  return store.move(task, "awaiting_spec_approval", { spec: head, head, pr });
}

async function gateOne(store: Store, git: StagePublisher, task: Task) {
  const pull = await git.boundPull(task);
  if (pull.headSha !== task.spec || !pull.draft) throw new Error("PR moved before spec approval");
  const cmd = `/approve ${task.spec}`;
  const commentId = await effect(store, task, "request-spec-approval", { pr: task.pr, cmd }, (a) =>
    git.comment(
      task.pr,
      a.id,
      `Review the spec in this draft and post the following command on this PR to authorize building.\n\n\`${cmd}\``,
    ),
  );
  store.db.run("INSERT OR IGNORE INTO factory_comments VALUES(?,?)", [commentId, task.id]);
  console.log(`${pull.htmlUrl}  ${cmd}`);
  const comments = await git.comments(task.pr);
  const revision = pendingRevision(store, task, comments);
  if (revision) return store.move(task, "spec_drafting", { reason: revision.feedback }, revision.event);
  const approval = pendingSpec(store, task, comments);
  return approval ? store.move(task, "building", {}, approval) : null;
}

export function runStages(store: Store, task: Task, services: Services) {
  const { git } = services;
  return drive(store, task, {
    received: (t) => store.move(t, "spec_drafting"),
    spec_drafting: (t) => draft(store, t, services),
    awaiting_spec_approval: (t) => gateOne(store, git, t),
    building: (t) => build(store, t, services),
    checks: (t) => checks(store, t, services),
    code_review: (t) => review(store, t, services),
    verifying: (t) => verify(store, t, services),
    awaiting_pr_approval: (t) => gateTwo(store, git, t),
    escalated: (t) => resolveVerification(store, git, t, services.stateRoot),
  });
}

export async function run(url: string, observe: Observer = (event, id) => console.log(event, id)) {
  const number = issueNumber(url);
  assertPrivateDir(config.stateRoot, config.stateRoot);
  process.umask(0o077);
  // SQLite releases this process-wide writer lock even on SIGKILL. State commits use a separate database.
  const lock = new Database(join(config.stateRoot, "controller-lock.sqlite"), { create: true });
  const project = new ProjectChecks();
  let opened: Store | undefined;
  try {
    lock.exec("BEGIN IMMEDIATE");
    const store = new Store(join(config.stateRoot, "factory.sqlite"));
    opened = store;
    const git = new Publisher();
    const issue = await git.issue(number);
    store.requireSlot(issue);
    const base = await git.ref(config.pilot.base);
    if (!base) throw new Error("missing base branch");
    const task = store.intake(issue, base);
    if (task.issue.revision !== issue.revision) throw new Error("issue changed since intake, owner respec required");
    return await runStages(store, task, { git, stateRoot: project.stateRoot, dispatch: dispatchWorker, observe,
      authorizeTeam: (harness,role,members) => requireSkillProofs(harness,role,members,"spec",loadDispatchConfig({agentWriteRoots:[config.workspaceRoot]})),
      test: (t, a, content) => project.test(t, a, content),
      verify: (t, a, prior) => verifyPilot(t, a, project, prior),
    });
  } finally {
    project.close();
    opened?.db.close();
    lock.close();
  }
}
