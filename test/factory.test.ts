import { expect, test } from "bun:test";
import { config, headingPilot, inventoryFixture, pilotBase } from "../factory.config";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pilotSessionLimits } from "../src/factory/worker";
import { headDecision, pendingRevision, pendingResume, pendingReverification, pendingSpec, specDecision } from "../src/factory/gates";
import capturedInventory from "./fixtures/pilot-inventory-captures.json";
import { issueNumber, readIssue } from "../src/factory/github";
import { RepoClient } from "../src/github/api";
import { InstallationToken } from "../src/github/app";
import { afterVerification, reviewVerdict } from "../src/factory/run";
import { requireHealthyInfrastructure } from "../src/factory/checks";
import { Uncertain, effect } from "../src/factory/machine";
import { reproductionFile, Store, type Approval, type Issue, type Task } from "../src/factory/store";
import { inventoryMatches } from "../src/factory/verify";

const old = "a".repeat(40);
const current = "b".repeat(40);
const owner = config.ownerId;
const issue: Issue = {
  source: "github",
  repoId: 11,
  issueId: 22,
  number: 4,
  title: "stock",
  body: "zero",
  sender: owner,
  revision: "revision",
  url: "https://github.com/Scylla23/factory-pilot/issues/4",
};
const approved: Approval = { kind: "comment", id: 12, actor: owner, sha: current, accepted: true, reason: "approved spec" };
function spec(s: Store) {
  const t = s.intake(issue, old);
  return s.move(s.move(t, "spec_drafting"), "awaiting_spec_approval", { spec: current, head: current, pr: 5 });
}
function comment(id: number, sha: string, actor: number = owner) {
  return { id, createdAt: "2026-01-01", updatedAt: "2026-01-01", lastEditedAt: null, authorId: actor, body: `/approve ${sha}`, htmlUrl: "", author: "login" };
}

test("intake binds source, repository and issue ids independently of mutable issue fields", () => {
  const s = new Store(":memory:");
  try {
    const t = s.intake(issue, old);
    expect(reproductionFile(t.issue)).toBe("repro-issue-4.test.ts");
    expect(reproductionFile(issue)).toBe("repro.test.ts");
    expect(() => reproductionFile({...t.issue, reproductionFile: "../outside"})).toThrow("assignment");
    expect(s.intake({ ...issue, title: "renamed", number: 999 }, current)).toEqual(t);
    expect(s.intake({ ...issue, repoId: 12 }, old).id).not.toBe(t.id);
    expect(s.intake({ ...issue, issueId: 23 }, old).id).not.toBe(t.id);
    expect(s.db.query("SELECT * FROM transitions").all()).toHaveLength(3);
    expect(s.db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
  } finally {
    s.db.close();
  }
});

test("GitHub intake authorizes the owner and the last factory label event for the current revision", async () => {
  const label = {
    event: "labeled",
    actor: { id: owner as number },
    label: { name: "factory" },
    created_at: "2026-01-02T00:00:00Z",
  };
  const raw = {
    databaseId: 10,
    author: { databaseId: owner as number },
    title: "stock",
    body: "0",
    url: issue.url,
    lastEditedAt: "2026-01-01T00:00:00Z",
    labels: { nodes: [{ name: "factory" }] },
  };
  const repo = { databaseId: config.pilot.repoId as number, issue: raw };
  let events = [label];
  let eventReads = 0;
  const client = new RepoClient(
    config.pilot.owner,
    config.pilot.repo,
    {
      get: async () => new InstallationToken("fixture", new Date(Date.now() + 600_000), [config.pilot.repo], {}),
    },
    async (url) => {
      if (url.endsWith("/graphql")) return Response.json({ data: { repository: repo } });
      eventReads++;
      return Response.json(events);
    },
  );
  expect((await readIssue(client, 4)).sender).toBe(owner);
  for (const invalid of [
    { ...label, actor: { id: 99 } },
    { ...label, event: "unlabeled" },
    { ...label, created_at: "invalid" },
    { ...label, created_at: raw.lastEditedAt },
  ]) {
    events = [label, invalid];
    await expect(readIssue(client, 4)).rejects.toThrow("reapply");
  }
  const rename = { ...label, event: "renamed", created_at: "2026-01-03T00:00:00Z" };
  events = [label, rename];
  await expect(readIssue(client, 4)).rejects.toThrow("reapply");
  events = [rename, { ...label, created_at: "2026-01-04T00:00:00Z" }];
  expect((await readIssue(client, 4)).sender).toBe(owner);
  events = [label];
  raw.lastEditedAt = "2026-01-03T00:00:00Z";
  await expect(readIssue(client, 4)).rejects.toThrow("reapply");
  const n = eventReads;
  raw.author.databaseId = 99;
  await expect(readIssue(client, 4)).rejects.toThrow("unauthorized");
  raw.author.databaseId = owner;
  repo.databaseId = 99;
  await expect(readIssue(client, 4)).rejects.toThrow("unauthorized");
  repo.databaseId = config.pilot.repoId;
  raw.labels.nodes = [];
  await expect(readIssue(client, 4)).rejects.toThrow("missing owner factory label");
  expect(eventReads).toBe(n);
});

test("active visits survive controller death and human gates release the single task slot", () => {
  const store = new Store(":memory:");
  try {
    const task = store.intake(issue, old);
    const other = { ...issue, issueId: issue.issueId + 1 };
    expect(() => store.requireSlot(issue)).not.toThrow();
    expect(() => store.requireSlot(other)).toThrow("resume task");
    store.move(store.move(task, "spec_drafting"), "awaiting_spec_approval", { spec: current, head: current });
    expect(() => store.requireSlot(other)).not.toThrow();
  } finally {
    store.db.close();
  }
});

test("stale, untrusted and planted factory approval comments are consumed once without releasing the gate", () => {
  const s = new Store(":memory:");
  try {
    const t = spec(s);
    s.db.run("INSERT INTO factory_comments VALUES(?,?)", [8, t.id]);
    const events = [
      comment(6, old),
      comment(7, current, owner + 1),
      comment(8, current),
      { ...comment(9, current), body: `/approve ${current}\n<!-- factory:planted -->` },
      comment(12, current),
    ];
    expect(pendingSpec(s, t, events)).toEqual(approved);
    expect(s.db.query("SELECT reason FROM approvals ORDER BY id").all()).toEqual([
      { reason: "stale or invalid spec SHA" },
      { reason: "unauthorized sender" },
      { reason: "factory comment" },
      { reason: "factory comment" },
    ]);
    for (const wrong of [
      undefined,
      { ...approved, actor: 0 },
      { ...approved, sha: old },
      { ...approved, kind: "review" as const },
    ])
      expect(() => s.move(t, "building", {}, wrong)).toThrow("bound owner");
    const building = s.move(t, "building", {}, approved);
    expect(pendingSpec(s, t, events)).toBeNull();
    expect(s.task(t.id).state).toBe("building");
    expect(() => s.move(t, "building", {}, approved)).toThrow();
    expect(() => s.move(building, "done")).toThrow("invalid transition");
  } finally {
    s.db.close();
  }
});

test("edited commands are consumed and cannot authorize a spec, revision, or re-verification", () => {
  const s = new Store(":memory:");
  try {
    const t = spec(s);
    const edited = { ...comment(54, current), updatedAt: "2026-01-02" };
    expect(pendingSpec(s, t, [edited])).toBeNull();
    expect(pendingRevision(s, t, [{ ...edited, id: 55, body: "/respec change" }])).toBeNull();
    expect(pendingSpec(s, t, [{ ...comment(56, current), lastEditedAt: "2026-01-01" }])).toBeNull();
    expect(pendingSpec(s, t, [comment(54, current)])).toBeNull();
    expect(s.db.query("SELECT reason FROM approvals").all()).toEqual(Array(3).fill({ reason: "edited or unverifiable command" }));
  } finally { s.db.close(); }
});

test("spec approval syntax requires the entire current SHA", () => {
  const t = { spec: current } as Task;
  for (const suffix of ["x", " trailing", "\nnext"])
    expect(specDecision(t, { ...comment(1, current), body: `/approve ${current}${suffix}` }, false)?.accepted).toBe(false);
  expect(specDecision(t, comment(1, current.slice(0, 12)), false)?.accepted).toBe(false);
});

test("a later rejection or dismissal supersedes an owner review and stale commits cannot finish", () => {
  const t = { head: current } as Task;
  const first = { id: 7, user: { id: owner }, state: "APPROVED", commit_id: current, submitted_at: "2026-01-01" };
  const decide = (reviews: Parameters<typeof headDecision>[1]) => headDecision(t, reviews, "2025-12-31");
  expect(decide([first])?.accepted).toBe(true);
  for (const boundary of ["2026-01-01", "2026-01-02", "invalid"])
    expect(headDecision(t, [first], boundary)?.reason).toBe("predates verified evidence");
  for (const state of ["CHANGES_REQUESTED", "DISMISSED"])
    expect(decide([{ ...first, id: 8, state, submitted_at: "2026-01-02" }, first])?.accepted).toBe(false);
  expect(decide([{ ...first, commit_id: old }])?.accepted).toBe(false);
  expect(decide([{ ...first, user: { id: owner + 1 } }])).toBeNull();
});

test("intent exists before an effect and retry reuses its id and completed result", async () => {
  const s = new Store(":memory:");
  try {
    const t = s.intake(issue, old);
    let id = "";
    await expect(
      effect(s, t, "dispatch", { head: old }, async (a) => {
        id = a.id;
        expect(s.db.query("SELECT intent FROM attempts WHERE id=?").get(id)).toEqual({ intent: JSON.stringify({ head: old }) });
        throw new Error("crash after dispatch");
      }),
    ).rejects.toThrow("crash");
    expect(
      await effect(s, t, "dispatch", { head: old }, async (a) => {
        expect(a.id).toBe(id);
        expect(a.fresh).toBe(false);
        return "adopted";
      }),
    ).toBe("adopted");
    expect(
      await effect<string>(s, t, "dispatch", { head: old }, async () => {
        throw new Error("duplicate");
      }),
    ).toBe("adopted");
    expect(() => s.plan(t, "dispatch", { head: current })).toThrow("intent changed");
    s.move(t, "spec_drafting");
    expect(() => s.plan(t, "late", {})).toThrow("stale transition");
  } finally {
    s.db.close();
  }
});

test("one failed verification repairs and a second escalates without releasing gate two", () => {
  const s = new Store(":memory:");
  try {
    let t = s.move(spec(s), "building", {}, approved);
    const verifying = (b: Task) => s.move(s.move(s.move(b, "checks"), "code_review"), "verifying");
    t = verifying(t);
    const result = {
      pr: t.pr,
      base: t.base,
      head: t.head,
      checks: [{ name: "AC-1", pass: false, detail: "unexpected count" }],
      captures: [],
      attemptId: crypto.randomUUID(),
      evidenceDir: "/tmp",
    };
    expect(() => afterVerification(s, t, { ...result, head: old })).toThrow("revisions");
    t = afterVerification(s, t, result);
    expect([t.state, t.repairCount]).toEqual(["building", 1]);
    t = afterVerification(s, verifying(t), result);
    expect(t.state).toBe("escalated");
    expect(() => s.move(t, "done")).toThrow();
  } finally {
    s.db.close();
  }
});

test("browser evidence checks the values beside all three inventory names", () => {
  const good = "Item | Stock count\n| Bench vises | 4 |\n| Measuring tapes | 0 |\n| Tool chests | Uncounted |";
  expect(inventoryMatches(good, "after")).toBe(true);
  expect(inventoryMatches(good, "before")).toBe(false);
  expect(inventoryMatches(good.replace("tapes | 0", "tapes | 10"), "after")).toBe(false);
  expect(inventoryMatches(good.replace("Tool chests", "Missing"), "after")).toBe(false);
  const captured = "# Equipment inventory\n\nItemStock count\n\nBench vises4\n\nMeasuring tapes0\n\nTool chestsUncounted";
  expect(inventoryMatches(captured, "after")).toBe(true);
  expect(inventoryMatches(captured, "before")).toBe(false);
  expect(inventoryMatches(`${captured}\nMeasuring tapesUncounted`, "after")).toBe(false);
});

test("the heading pilot binds its isolated base, column heading and unchanged inventory", () => {
  const f = inventoryFixture(6);
  const page = "ItemPrice\nBench vises4\nMeasuring tapes0\nTool chestsUncounted";
  expect(pilotBase(6)).toBe(headingPilot.base);
  expect(pilotBase(4)).toBe("main");
  expect(inventoryMatches(page, "before", f.rows, f.heading)).toBe(true);
  expect(inventoryMatches(page, "after", f.rows, f.heading)).toBe(false);
  expect(inventoryMatches(page.replace("ItemPrice", "Item | Stock count"), "after", f.rows, f.heading)).toBe(true);
  expect(inventoryMatches(page.replace("tapes0", "tapes1"), "before", f.rows, f.heading)).toBe(false);
});

test("the pilot stops before an unpriced or unaffordable Claude session including a repair", () => {
  const store = new Store(":memory:");
  const root = mkdtempSync(join(tmpdir(), "factory-pilot-limit-"));
  try {
    const t = store.intake({ ...issue, number: headingPilot.issues[0] }, old);
    const prior = store.plan(t, "dispatch-spec", {});
    const dir = join(root, "jobs", prior.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "job.json"), JSON.stringify({ agent: config.agents.spec }));
    const next = crypto.randomUUID();
    expect(pilotSessionLimits(store, t, next, "builder", false, root)).toBeUndefined();
    expect(() => pilotSessionLimits(store, t, next, "reviewer", false, root)).toThrow("reconciliation");
    store.db.run("INSERT INTO audit(attempt,task,stage,requested_model,effort,base,head,outcome,prompt_revision) VALUES(?,?,?,?,?,?,?,?,?)",
      [prior.id,t.id,t.state,config.agents.spec.model,"high",old,old,"completed","a".repeat(64)]);
    const capture = (costUsd: number) => store.db.run("INSERT OR REPLACE INTO usage_captures VALUES(?,?,?)",
      [prior.id, "match", JSON.stringify({ coverage: "complete", costUsd })]);
    capture(1.25);
    expect(pilotSessionLimits(store, t, next, "reviewer", false, root)?.maxUsd).toBe(0.75);
    capture(1.250001);
    const replacement = store.intake({ ...issue, issueId: issue.issueId + 1, number: headingPilot.issues[1] }, old);
    expect(() => pilotSessionLimits(store, replacement, next, "reviewer", false, root)).toThrow("cap");
    expect(() => pilotSessionLimits(store, t, next, "spec", true, root)).toThrow("cap");
  } finally {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const capture of capturedInventory.captures) {
  test(`Orca saved inventory rows: ${capture.name}`, () => {
    const phase = capture.name.startsWith("before-") ? "before" : "after";
    expect(inventoryMatches(capture.pageText, phase)).toBe(true);
    expect(inventoryMatches(capture.pageText, phase === "before" ? "after" : "before")).toBe(false);
    expect(capture.commitSha).toBe(phase === "before" ? capturedInventory.base : capturedInventory.head);
  });
}

test("re-verification requires a fresh owner comment on the same reviewed head after verification escalation", () => {
  const s = new Store(":memory:");
  try {
    let t = s.move(spec(s), "building", {}, approved);
    t = s.move(s.move(t, "checks", { repairCount: 1 }), "code_review");
    const a = s.plan(t, "code-review", { base: t.base, head: t.head });
    s.finish(a.id, { base: t.base, head: t.head, verdict: "approve" });
    t = s.move(t, "verifying");
    const cmd = (id: number, sha = current, actor: number = owner) => ({ ...comment(id, sha, actor), body: `/reverify ${sha}` });
    const valid = cmd(30);
    expect(pendingReverification(s, t, [valid], 20, current)).toBeNull();
    t = s.move(t, "escalated", { reason: "failed verification: table rows" });
    expect(pendingReverification(s, t, [valid], 20, old)).toBeNull();
    s.db.run("INSERT INTO factory_comments VALUES(?,?)", [25, t.id]);
    const invalid = [
      cmd(19),
      cmd(22, old),
      cmd(23, current, owner + 1),
      { ...cmd(24), body: `${cmd(24).body}\n<!-- factory:planted -->` },
      cmd(25),
      { ...cmd(26), lastEditedAt: '2026-01-01' },
    ];
    expect(pendingReverification(s, t, invalid, 20, current)).toBeNull();
    const rows = s.db.query("SELECT id,reason FROM approvals WHERE id>=19 ORDER BY id").all();
    expect(rows).toEqual([
      { id: 19, reason: "command predates escalation" },
      { id: 22, reason: "stale or invalid reviewed head" },
      { id: 23, reason: "unauthorized sender" },
      { id: 24, reason: "factory comment" },
      { id: 25, reason: "factory comment" },
      { id: 26, reason: "edited or unverifiable command" },
    ]);
    expect(pendingReverification(s, t, [cmd(22)], 20, current)).toBeNull();
    const event = pendingReverification(s, t, [cmd(31), valid, valid], 20, current);
    if (!event) throw new Error("expected owner resolution");
    expect(event.id).toBe(30);
    expect(s.db.query("SELECT accepted,reason FROM approvals WHERE id=31").get()).toEqual({
      accepted: 0,
      reason: "duplicate of re-verification comment 30",
    });
    expect(event.accepted).toBe(false);
    expect(() => s.move(t, "done", {}, event)).toThrow();
    expect(() => s.move(t, "verifying", { repairCount: 0 }, event)).toThrow();
    t = s.move(t, "verifying", {}, event);
    expect(t.repairCount).toBe(1);
    t = s.move(t, "escalated", { reason: "failed verification: still failing" });
    expect(pendingReverification(s, t, [valid, cmd(31)], 20, current)).toBeNull();
    expect(() => s.move(t, "verifying", {}, event)).toThrow("consumed");
    expect(s.task(t.id).state).toBe("escalated");
  } finally {
    s.db.close();
  }
});

test("CLI routes only a registered issue and reviewer output must have a verdict and rationale", () => {
  expect(issueNumber(issue.url)).toBe(4);
  for (const url of [
    `${issue.url}?x`,
    issue.url.replace("issues", "pull"),
    issue.url.replace("factory-pilot", "other"),
    issue.url.replace("github.com", "github.com.bad"),
  ])
    expect(() => issueNumber(url)).toThrow();
  expect(reviewVerdict('{"verdict":"approve","rationale":"app.ts:2 AC-1"}').verdict).toBe("approve");
  for (const input of ["approve", '{"verdict":"approve"}', '{"verdict":"unknown","rationale":"x"}'])
    expect(() => reviewVerdict(input)).toThrow();
});

test("infrastructure failure escalates without consuming a code repair", async () => {
  for (const [name, detail] of [
    ["test teardown", "removed false"], ["lint", "exit 127\nenv: node: No such file or directory"],
    ["typecheck", "exit 126"], ["test", "exit 1\nOperation not permitted"], ["test", "timed_out"],
    ["test", "exit 1; left behind: child"], ["complete browser verification", "browser unavailable"],
  ]) expect(() => requireHealthyInfrastructure([{ name: name!, detail: detail!, pass: false }])).toThrow(Uncertain);
  expect(() => requireHealthyInfrastructure([{ name: "lint", detail: "exit 1\ninvalid syntax", pass: false }])).not.toThrow();
  const s = new Store(":memory:");
  try {
    const build = s.move(spec(s), "building", {}, approved);
    const t = s.move(s.move(s.move(build, "checks"), "code_review"), "verifying");
    expect(() => afterVerification(s, t, { pr: t.pr, base: t.base, head: t.head, captures: [], evidenceDir: "/fixture",
      attemptId: "fixture", checks: [{ name: "before teardown", pass: false, detail: "removed false" }] })).toThrow(Uncertain);
    expect(s.task(t.id).repairCount).toBe(0);
  } finally { s.db.close(); }
});

test("owner resume replaces only the interrupted read-only attempt and preserves builder, head and repair allowance", () => {
  for (const action of ["base-reproduction", "head-checks", "verify"]) {
    const s = new Store(":memory:");
    try {
      let t = s.move(spec(s), "building", { repairCount: 1, reason: "fix fixture" }, approved);
      const builder = s.plan(t, action === "base-reproduction" ? "dispatch-builder-validation-retry" : "dispatch-builder", "intent");
      s.finish(builder.id, ["original patch"]);
      if (action !== "base-reproduction") t = s.move(t, "checks");
      if (action === "verify") t = s.move(s.move(t, "code_review"), "verifying");
      for (const n of [0, 1]) {
        const before = t;
        const attempt = s.plan(t, action, { head: current });
        t = s.move(t, "escalated", { reason: `interrupted ${action === "verify" ? "browser capture" : "project check"} ${attempt.id}` });
        const interrupted = s.interrupted(t)!;
        expect(interrupted.id).toBe(attempt.id);
        const ownerCommand = { ...comment(50 + n, current), body: `/resume ${attempt.id}` };
        expect(pendingResume(s, t, [{ ...ownerCommand, id: 40+n, lastEditedAt: "2026-01-02" }], 35, attempt.id)).toBeNull();
        const event = pendingResume(s, t, [ownerCommand], 35, attempt.id)!;
        expect(() => s.move(t, before.state, { reason: before.reason, repairCount: 0 }, event)).toThrow();
        expect(() => s.move(t, before.state, { reason: before.reason }, { ...event, actor: owner+1 })).toThrow();
        t = s.move(t, before.state, { reason: before.reason }, event);
        expect(t.head).toBe(before.head);
        expect(t.repairCount).toBe(1);
        expect(s.plan(t, action, { head: current }).id).not.toBe(attempt.id);
        if (action === "base-reproduction") expect(s.plan(t, "dispatch-builder", "intent").id).toBe(builder.id);
        expect(pendingResume(s, t, [ownerCommand], 35, attempt.id)).toBeNull();
      }
    } finally { s.db.close(); }
  }
});

test("reverification authority requires the persisted escalation and a matching approved code review", () => {
  for (const variation of ["valid", "changes", "previous", "review-base", "review-head", "reason", "no-review"]) {
    const s = new Store(":memory:");
    try {
      let t = s.move(spec(s), "building", {}, approved);
      t = s.move(s.move(t, "checks"), "code_review");
      if (variation !== "no-review") {
        const a = s.plan(t, "code-review", {});
        s.finish(a.id, { verdict: variation === "changes" ? "changes" : "approve",
          base: variation === "review-base" ? current : t.base, head: variation === "review-head" ? old : t.head });
      }
      if (variation !== "previous") t = s.move(t, "verifying");
      t = s.move(t, "escalated", { reason: variation === "reason" ? "worker disappeared" : "failed verification: AC-1" });
      const command = { ...comment(82, current), body: "/reverify " + current };
      expect(s.canReverify(t)).toBe(variation === "valid");
      expect(!!pendingReverification(s, t, [command], 65, current)).toBe(variation === "valid");
      if (variation === "valid") {
        for (const stale of [{ ...t, visit: t.visit - 1 }, { ...t, base: current }, { ...t, head: old }, { ...t, state: "verifying" as const }])
          expect(s.canReverify(stale)).toBe(false);
      }
    } finally { s.db.close(); }
  }
});
