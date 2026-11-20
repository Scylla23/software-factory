import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/factory/store";

const actions = ["dispatch-triage", "dispatch-spec", "commit-spec", "open-draft", "request-spec-approval", "dispatch-builder", "base-reproduction",
  "commit-fix", "head-checks", "code-review", "verify", "publish-evidence", "mark-ready"];
const states = ["received", "spec_drafting", "awaiting_spec_approval", "building", "checks", "code_review", "verifying", "awaiting_pr_approval", "done"];

async function invoke(root: string, scenario: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/factory-crash.fixture.ts"), root, scenario],
    { env: { PATH: "/usr/bin:/bin" }, stdout: "ignore", stdin: "ignore", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
  try {
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (child.signalCode === "SIGKILL") return false;
    if (code !== 0) throw new Error(error || "fixture exit " + code);
    return true;
  } finally { clearTimeout(timer); }
}
test("restarting after SIGKILL at every real stage and effect adopts every external resource once", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-crash-test-"));
  try {
    const expected = [...states.map(s => s + ".entered"), ...actions.flatMap(a =>
      ["planned", "external", "before-finish", "finished"].map(p => a + "." + p))].sort();
    let kills = 0;
    while (kills <= expected.length && !await invoke(root, "crash")) kills++;
    expect(kills).toBe(expected.length);
    expect(readdirSync(root).filter(n => n.endsWith(".kill")).map(n => n.slice(0,-5)).sort()).toEqual(expected);
    const s = new Store(join(root, "state.sqlite"));
    try {
      expect(s.task(1).state).toBe("done");
      expect(s.db.query("SELECT state FROM transitions ORDER BY visit").all().map(row => (row as {state:string}).state)).toEqual(states);
      expect(s.db.query("SELECT id FROM attempts WHERE result IS NOT NULL").all()).toHaveLength(actions.length);
      expect(readdirSync(root).filter(n => n.endsWith(".resource"))).toHaveLength(actions.length);
      expect(s.db.query("SELECT id FROM approvals WHERE accepted=1").all()).toHaveLength(2);
    } finally { s.db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

for (const scenario of ["missing-repro", "edited-test", "infra"]) test("real stages stop on " + scenario, async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-stage-test-"));
  try {
    expect(await invoke(root, scenario)).toBe(true);
    const s = new Store(join(root, "state.sqlite"));
    try {
      expect(s.task(1).state).toBe(scenario === "missing-repro" ? "failed" : "escalated");
      expect(s.task(1).repairCount).toBe(0);
      expect(s.db.query("SELECT id FROM attempts WHERE action='verify'").all()).toHaveLength(0);
      if (scenario !== "missing-repro") expect(readdirSync(root).filter(n => n.endsWith("report-escalation.resource"))).toHaveLength(1);
    } finally { s.db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of ["resume-base", "resume-check", "resume-capture", "reverify"]) test("real stages recover through " + scenario, async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-resume-test-"));
  try {
    expect(await invoke(root, scenario)).toBe(true);
    const s = new Store(join(root, "state.sqlite"));
    try {
      expect(s.task(1).state).toBe("done");
      expect(s.task(1).repairCount).toBe(scenario === "reverify" ? 1 : 0);
      const resources = readdirSync(root).filter(n => n.endsWith(".resource"));
      expect(resources.filter(n => n.endsWith("dispatch-builder.resource"))).toHaveLength(scenario === "reverify" ? 2 : 1);
      expect(resources.filter(n => n.includes("report-"))).toHaveLength(1);
      expect(s.db.query("SELECT id FROM attempts WHERE result IS NULL").all()).toHaveLength(scenario === "reverify" ? 0 : 1);
    } finally { s.db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [scenario, action] of [
  ["infra", "report-escalation"], ["resume-check", "report-interruption"],
  ["reverify", "report-verification-escalation"], ["login", "dispatch-spec-after-login"],
] as const) test("restart adopts the recovery effect " + action, async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-recovery-crash-"));
  try {
    for (let i = 0; i < 4; i++) expect(await invoke(root, "crash-" + scenario)).toBe(false);
    expect(await invoke(root, "crash-" + scenario)).toBe(true);
    const s = new Store(join(root, "state.sqlite"));
    try {
      expect(s.task(1).state).toBe(scenario === "infra" ? "escalated" : "done");
      const files = readdirSync(root);
      expect(files.filter(n => n.endsWith(action + ".resource"))).toHaveLength(1);
      expect(files.filter(n => n.endsWith(".kill")).sort()).toEqual(
        ["before-finish", "external", "finished", "planned"].map(p => action + "." + p + ".kill"));
    } finally { s.db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("owner feedback returns a spec revision to the same high-effort lead before building", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-revision-"));
  try {
    expect(await invoke(root, "revision")).toBe(true);
    const s = new Store(join(root, "state.sqlite"));
    try {
      expect(s.task(1).state).toBe("done");
      expect(s.task(1).spec).toBe("d".repeat(40));
      expect(s.db.query("SELECT id FROM attempts WHERE action='dispatch-spec'").all()).toHaveLength(2);
      expect(s.db.query("SELECT sha FROM approvals WHERE kind='comment' AND accepted=1").all()).toEqual([{ sha: "d".repeat(40) }]);
    } finally { s.db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("gate two persists both review and inline owner feedback while completing approval", async () => {
  const root = mkdtempSync(join(tmpdir(),"factory-feedback-"));
  try {
    expect(await invoke(root,"feedback")).toBe(true);
    const store = new Store(join(root,"state.sqlite"));
    try {
      expect(store.task(1).state).toBe("done");
      expect(store.db.query("SELECT id,kind,body FROM owner_feedback ORDER BY id").all()).toEqual([
        { id:21, kind:"review", body:"Review feedback" }, { id:22, kind:"inline", body:"Inline feedback" },
      ]);
    } finally { store.db.close(); }
  } finally { rmSync(root,{ recursive:true, force:true }); }
});

test.each(["denied","store","timeout"])("gate two records a feedback %s failure and still accepts the owner's review", async failure => {
  const root = mkdtempSync(join(tmpdir(),"factory-gate-"));
  try {
    expect(await invoke(root,"feedback-" + failure)).toBe(true);
    const s = new Store(join(root,"state.sqlite"));
    try {
      expect(s.task(1).state).toBe("done");
      const rows = s.db.query("SELECT kind,reason FROM feedback_failures ORDER BY kind").all();
      expect(rows).toEqual(failure === "timeout" ? [{kind:"inline",reason:"inline feedback deadline exceeded"}] : failure === "denied" ? [{kind:"inline",reason:"fixture inline read refused"}] : [
        {kind:"inline",reason:"fixture write refused"},{kind:"review",reason:"fixture write refused"},
      ]);
    } finally { s.db.close(); }
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

for (const scenario of ["tier-L", "security-M"]) test("unproven spec team stops before gate 1 on " + scenario, async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-team-gate-"));
  try {
    expect(await invoke(root, scenario)).toBe(true);
    const store = new Store(join(root, "state.sqlite"));
    try {
      const task = store.task(1);
      expect(task.state).toBe("escalated");
      expect(task.reason).toContain("team required");
      expect(task.spec).toBe("");
      expect(store.db.query("SELECT id FROM attempts WHERE action='dispatch-spec' AND result IS NOT NULL").all()).toHaveLength(0);
      expect(store.db.query("SELECT id FROM attempts WHERE action IN ('commit-spec','open-draft','request-spec-approval')").all()).toHaveLength(0);
      expect(store.db.query("SELECT id FROM approvals").all()).toHaveLength(0);
    } finally { store.db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of ["invalid-verdict", "replacement"]) test("reviewer " + scenario + " cannot advance past review", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-review-escalation-"));
  try {
    expect(await invoke(root, scenario)).toBe(true);
    const s = new Store(join(root, "state.sqlite"));
    try {
      const t = s.task(1);
      expect(t.state).toBe("escalated");
      expect(t.reason).toContain(scenario === "replacement" ? "output integrity escalation" : "validation twice");
      expect(s.db.query("SELECT result FROM attempts WHERE action LIKE 'code-review%' AND result IS NULL").all())
        .toHaveLength(scenario === "replacement" ? 1 : 2);
      expect(s.db.query("SELECT id FROM attempts WHERE action='verify'").all()).toEqual([]);
      expect(s.db.query("SELECT id FROM approvals WHERE kind='review'").all()).toEqual([]);
      expect(s.db.query("SELECT attempt FROM skill_collections WHERE role='code-reviewer'").all()).toEqual([]);
    } finally { s.db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const trigger of ["tier-L", "security-M"]) test("eligible team handoff uses a fresh scoped attempt for " + trigger, async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-team-handoff-"));
  try {
    expect(await invoke(root, "eligible-" + trigger)).toBe(true);
    const s = new Store(join(root, "state.sqlite"));
    try {
      expect(s.task(1).state).toBe("done");
      expect(s.db.query("SELECT id FROM attempts WHERE action='dispatch-spec' AND result IS NULL").all()).toHaveLength(1);
      expect(s.db.query("SELECT id FROM attempts WHERE action='dispatch-spec-with-team' AND result IS NOT NULL").all()).toHaveLength(1);
      expect(s.db.query("SELECT id FROM approvals WHERE accepted=1").all()).toHaveLength(2);
    } finally { s.db.close(); }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("a schema-valid second reviewer attempt supplies the approval used by the final gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-review-retry-"));
  try {
    expect(await invoke(root, "retry-review")).toBe(true);
    const s = new Store(join(root, "state.sqlite"));
    try {
      expect(s.task(1).state).toBe("done");
      expect(s.db.query("SELECT id FROM attempts WHERE action='code-review' AND result IS NULL").all()).toHaveLength(1);
      expect(s.db.query("SELECT id FROM attempts WHERE action='code-review-validation-retry' AND result IS NOT NULL").all()).toHaveLength(1);
    } finally { s.db.close(); }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("verification retries infrastructure once, checks leases, and uses the latest receipt for gate two", async () => {
  for (const scenario of ["capture-transient", "capture-outage", "capture-lease"]) {
    const root = mkdtempSync(join(tmpdir(), "factory-infra-test-"));
    try {
      if (scenario === "capture-lease") {
        await expect(invoke(root, scenario)).rejects.toThrow("still needs teardown");
        const saved = new Store(join(root, "state.sqlite"));
        try {
          expect(saved.task(1).state).toBe("escalated");
          expect(saved.db.query("SELECT id FROM attempts WHERE action='verify-infra-retry'").all()).toHaveLength(0);
        } finally { saved.db.close(); }
        rmSync(join(root, "ports", "fixture.lease"));
      }
      expect(await invoke(root, scenario)).toBe(true);
      const s = new Store(join(root, "state.sqlite"));
      try {
        expect(s.task(1).state).toBe("done");
        expect(s.task(1).repairCount).toBe(0);
        const receipts = s.db.query("SELECT id FROM attempts WHERE action LIKE 'verify%' AND result IS NOT NULL").all();
        expect(receipts.length).toBe(scenario === "capture-outage" ? 3 : 2);
        const commands = s.db.query("SELECT accepted FROM approvals WHERE reason='owner requested re-verification'").all();
        expect(commands).toEqual(scenario === "capture-transient" ? [] : [{accepted: 0}]);
      } finally {s.db.close();}
    } finally {rmSync(root, {recursive:true, force:true});}
  }
});
