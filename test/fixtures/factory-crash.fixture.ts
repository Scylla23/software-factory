import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../factory.config";
import { drive, effect, type Stages } from "../../src/factory/machine";
import { Store, type Approval, type State, type Task } from "../../src/factory/store";

const root = process.argv[2] ?? "";
if (!root) throw new Error("fixture directory required");
const store = new Store(join(root, "state.sqlite"));
const base = "a".repeat(40);
const head = "b".repeat(40);
const issue = {
  source: "github" as const,
  repoId: 10,
  issueId: 11,
  number: 4,
  title: "count",
  body: "zero",
  sender: config.ownerId,
  revision: "one",
  url: "fixture",
};
const t = store.intake(issue, base);

function killOnce(marker: string) {
  if (existsSync(marker)) return;
  writeFileSync(marker, "killed", { flag: "wx" });
  process.kill(process.pid, "SIGKILL");
}

async function stage(task: Task, next: State) {
  const start = join(root, String(task.visit));
  // Crash as soon as the transition is visible in a separate process.
  if (store.task(task.id).state !== task.state) throw new Error("stage precedes durable transition");
  killOnce(`${start}.entered`);
  await effect(store, task, `fake-${task.state}`, { head: task.head }, async (attempt) => {
    const remote = `${start}.worker`;
    if (attempt.fresh) writeFileSync(remote, attempt.id, { flag: "wx" });
    if (readFileSync(remote, "utf8") !== attempt.id) throw new Error("duplicate external action");
    // Kill after the simulated side effect but before its result can be committed.
    killOnce(`${start}.started`);
    return { adopted: true, id: attempt.id };
  });
  let approval: Approval | undefined;
  if (task.state === "awaiting_spec_approval" || task.state === "awaiting_pr_approval") {
    approval = {
      kind: next === "done" ? "review" : "comment",
      id: task.visit,
      actor: config.ownerId,
      sha: head,
      accepted: true,
      reason: "fixture approval",
    };
  }
  return store.move(task, next, next === "awaiting_spec_approval" ? { spec: head, head, pr: 5 } : {}, approval);
}
const stages: Stages = {
  received: (t) => stage(t, "spec_drafting"),
  spec_drafting: (t) => stage(t, "awaiting_spec_approval"),
  awaiting_spec_approval: (t) => stage(t, "building"),
  building: (t) => stage(t, "checks"),
  checks: (t) => stage(t, "code_review"),
  code_review: (t) => stage(t, "verifying"),
  verifying: (t) => stage(t, "awaiting_pr_approval"),
  awaiting_pr_approval: (t) => stage(t, "done"),
  escalated: () => {
    throw new Error("unexpected escalation");
  },
};
try {
  const final = await drive(store, t, stages);
  if (final.state !== "done") throw new Error(`stopped at ${final.state}`);
  killOnce(join(root, "done.entered"));
} finally {
  store.db.close();
}
