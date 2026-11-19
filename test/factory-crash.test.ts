import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/factory/store";

const actions = ["dispatch-spec", "commit-spec", "open-draft", "request-spec-approval", "dispatch-builder", "base-reproduction",
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
