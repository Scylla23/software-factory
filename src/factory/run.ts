import { Database } from "bun:sqlite";
import { join } from "node:path";
import { config } from "../../factory.config";
import { assertPrivateDir } from "../dispatch/config";
import { Publisher, issueNumber } from "./github";
import { headDecision, pendingRevision, pendingReverification, pendingSpec, type Review } from "./gates";
import { buildPrompt, reviewPrompt, specPrompt } from "./prompts";
import { ProjectChecks, requireHealthyInfrastructure } from "./checks";
import { runGit } from "../dispatch/git";
import { verdict, check, type Check } from "../verify/verdict";
import { fenced, publishSummary, redact, type EvidenceSummary } from "../github/summary";
import { verifyPilot } from "./verify";
import { Store, type Task } from "./store";
import { dispatchWorker, protectsChecks, WorkerLoginError } from "./worker";

import { drive, effect } from "./machine";

export type Observer = (event: string, id: string) => void;
function repair(store: Store, task: Task, reason: string) {
  if (task.repairCount) return store.move(task, "escalated", { reason });
  return store.move(task, "building", { reason, repairCount: 1 });
}

async function build(store: Store, git: Publisher, task: Task, project: ProjectChecks, observe: Observer) {
  const approved = store.db
    .query("SELECT id FROM approvals WHERE task=? AND kind='comment' AND accepted=1 AND sha=?")
    .get(task.id, task.spec);
  if (!approved) throw new Error("spec has no owner approval");
  const prompt = buildPrompt(task);
  const files = await effect(store, task, "dispatch-builder", { base: task.base, head: task.head, prompt }, async (a) => {
    await git.boundPull(task);
    await git.fetch(task.head);
    return (await dispatchWorker(store, task, a, "builder", prompt, observe)).files;
  });
  const protectedFile = files.find((f) => protectsChecks(f.path));
  if (protectedFile) return store.move(task, "escalated", { reason: `builder changed check configuration: ${protectedFile.path}` });
  const repro = files.find((f) => f.path === "repro.test.ts");
  if ((!repro || files.length === 0) && !task.repairCount)
    return store.move(task, "failed", { reason: "builder omitted repro.test.ts" });
  const existing = new Set(
    runGit("/usr/bin/git", config.pilot.path, ["ls-tree", "-rz", "--name-only", task.base]).toString().split("\0"),
  );
  if (files.some((f) => existing.has(f.path) && /(?:^|\/)(?:test|tests)\/|\.(?:spec|test)\.[a-z]+$/.test(f.path)))
    return store.move(task, "escalated", { reason: "builder changed an existing test" });
  const content =
    repro?.content ?? runGit("/usr/bin/git", config.pilot.path, ["show", `${task.head}:repro.test.ts`]).toString("base64");
  const proof = await effect(store, task, "base-reproduction", { base: task.base, content }, (a) =>
    project.test(task, a, content),
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

async function checks(store: Store, git: Publisher, task: Task, project: ProjectChecks) {
  await git.boundPull(task);
  const result = await effect(store, task, "head-checks", { base: task.base, head: task.head }, async (a) => {
    await git.fetch(task.head);
    return project.test(task, a);
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

async function review(store: Store, git: Publisher, task: Task, observe: Observer) {
  if (String(config.agents.builder.harness) === config.agents.reviewer.harness)
    throw new Error("review must use the opposite vendor");
  const prompt = reviewPrompt(task);
  const result = await effect(store, task, "code-review", { base: task.base, head: task.head, prompt }, async (a) => {
    await git.boundPull(task);
    const output = await dispatchWorker(store, task, a, "reviewer", prompt, observe);
    return { base: task.base, head: task.head, ...reviewVerdict(output.result.resultText ?? "") };
  });
  return result.verdict === "approve" ? store.move(task, "verifying") : repair(store, task, result.rationale);
}

function latest<T>(store: Store, task: Task, action: string): T {
  const row = store.db
    .query<{ result: string }, [number, string]>(
      "SELECT result FROM attempts WHERE task=? AND action=? AND result IS NOT NULL ORDER BY visit DESC LIMIT 1",
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

async function verify(store: Store, git: Publisher, task: Task, project: ProjectChecks) {
  await git.boundPull(task);
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
    verifyPilot(task, a, project, prior),
  );
  return afterVerification(store, task, evidence);
}

async function gateTwo(store: Store, git: Publisher, task: Task) {
  await git.boundPull(task);
  const evidence = latest<EvidenceSummary>(store, task, "verify");
  if (evidence.base !== task.base || evidence.head !== task.head || !verdict(evidence.checks).pass)
    throw new Error("missing verification of current head");
  const comment = await effect(store, task, "publish-evidence", { pr: task.pr, attempt: evidence.attemptId }, () =>
    publishSummary(git.pulls, evidence, { botLogin: `${git.meta.slug}[bot]` }),
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
  const decision = headDecision(task, await git.pages<Review>(`/pulls/${task.pr}/reviews`), readyAt);
  if (!decision) return null;
  if (!decision.accepted) {
    store.record(task.id, decision);
    return null;
  }
  await git.boundPull(task);
  return store.move(task, "done", {}, decision);
}

async function resolveVerification(store: Store, git: Publisher, task: Task) {
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

async function draft(store: Store, git: Publisher, task: Task, observe: Observer) {
  const prompt = specPrompt(task);
  const writeSpec = (action: string) =>
    effect(store, task, action, { head: task.head, prompt }, async (a) => {
      await git.fetch(task.head);
      const output = await dispatchWorker(store, task, a, "spec", prompt, observe);
      const text = output.result.resultText?.trim() ?? "";
      if (!text.includes("AC-1") || text.length > 32_000) throw new Error("invalid spec writer output");
      return `${text}\n`;
    });
  let spec: string;
  try {
    spec = await writeSpec("dispatch-spec");
  } catch (e) {
    if (!(e instanceof WorkerLoginError)) throw e;
    spec = await writeSpec("dispatch-spec-after-login");
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

async function gateOne(store: Store, git: Publisher, task: Task) {
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
    return await drive(store, task, {
      received: (t) => store.move(t, "spec_drafting"),
      spec_drafting: (t) => draft(store, git, t, observe),
      awaiting_spec_approval: (t) => gateOne(store, git, t),
      building: (t) => build(store, git, t, project, observe),
      checks: (t) => checks(store, git, t, project),
      code_review: (t) => review(store, git, t, observe),
      verifying: (t) => verify(store, git, t, project),
      awaiting_pr_approval: (t) => gateTwo(store, git, t),
      escalated: (t) => resolveVerification(store, git, t),
    });
  } finally {
    project.close();
    opened?.db.close();
    lock.close();
  }
}
