import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../factory.config";
import { InvalidSkillOutput } from "../../src/factory/skill-validation";
import { Uncertain } from "../../src/factory/machine";
import { runStages } from "../../src/factory/run";
import { Store, type Task, type Attempt } from "../../src/factory/store";
import type { Review } from "../../src/factory/gates";
import { WorkerLoginError, type WorkerOutput } from "../../src/factory/worker";

const root = process.argv[2]!;
const mode = process.argv[3] ?? "crash";
const scenario = mode.replace(/^crash-/, "");
const recoveryAction: Record<string, string> = { infra: "report-escalation", reverify: "report-verification-escalation",
  "resume-check": "report-interruption", login: "dispatch-spec-after-login" };
const base = "a".repeat(40), spec = "b".repeat(40), head = "c".repeat(40);
function checkpoint(key: string) {
  const path = join(root, key + ".kill");
  const covered = mode === "crash" || (mode.startsWith("crash-") && key.startsWith(recoveryAction[scenario] + "."));
  if (!covered || existsSync(path)) return;
  writeFileSync(path, key, { flag: "wx" });
  process.kill(process.pid, "SIGKILL");
}
class CrashStore extends Store {
  override plan(...args: Parameters<Store["plan"]>) {
    const a = super.plan(...args);
    if (a.result === null) checkpoint(a.action + ".planned");
    return a;
  }
  override finish(id: string, value: unknown) {
    const a = this.db.query<{ action: string }, [string]>("SELECT action FROM attempts WHERE id=?").get(id)!;
    checkpoint(a.action + ".before-finish");
    super.finish(id, value);
    checkpoint(a.action + ".finished");
  }
  override move(...args: Parameters<Store["move"]>) {
    const t = super.move(...args);
    checkpoint(t.state + ".entered");
    return t;
  }
}
const s = new CrashStore(join(root, "state.sqlite"));
const issue = { source: "github" as const, repoId: 11, issueId: 12, number: 4, title: "stock", body: "zero",
  sender: config.ownerId, revision: "one", url: "https://github.com/Scylla23/factory-pilot/issues/4" };
const initial = s.intake(issue, base);
checkpoint(initial.state + ".entered");

// An external resource survives the controller independently of the SQLite result, keyed by visit and action.
function remote<T>(action: string, value: T, expectedId?: string): T {
  const t = s.task(initial.id);
  const a = s.db.query<{id: string; intent: string}, [number,number,string]>("SELECT id,intent FROM attempts WHERE task=? AND visit=? AND action=?")
    .get(t.id, t.visit, action);
  if (!a || !a.intent || (expectedId && expectedId !== a.id)) throw Error("effect before intent: " + action);
  const file = join(root, `${t.visit}-${action}.resource`);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ id: a.id, value }), { flag: "wx" });
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (record.id !== a.id) throw Error("duplicate external effect: " + action);
  checkpoint(action + ".external");
  return record.value;
}
function interruptOnce(a: Attempt, which: string) {
  const file = join(root, "interrupted");
  if (scenario !== which || existsSync(file)) return;
  writeFileSync(file, a.id, { flag: "wx" });
  throw new Uncertain(`interrupted ${which === "resume-capture" ? "browser capture" : "project check"} ${a.id}`);
}
const passed = (name: string, detail = "ok") => ({ name, detail, pass: true });
const pull = (t: Task) => ({ number: 5, htmlUrl: "fixture", baseSha: base, baseRef: "main", headSha: t.head,
  state: "open", draft: !existsSync(join(root, t.visit + "-mark-ready.resource")) });
const when = "2026-01-01T00:00:00Z";
const revised = "d".repeat(40);
const git: Parameters<typeof runStages>[2]["git"] = {
  boundPull: async t => pull(t), fetch: async () => {}, basePaths: () => new Set(["app.test.ts"]),
  reproduction: () => { throw Error("unexpected fallback"); },
  commit: async (t,id) => remote(t.state === "building" ? "commit-fix" : "commit-spec", t.state === "building" ? head : t.spec ? revised : spec, id),
  draft: async (_t,id) => remote("open-draft", 5, id),
  comment: async (_pr,id) => {
    const t = s.task(1);
    const action = t.state !== "escalated" ? "request-spec-approval" : s.interrupted(t) ? "report-interruption" :
      s.canReverify(t) ? "report-verification-escalation" : "report-escalation";
    return remote(action, 10, id);
  },
  comments: async () => {
    const t = s.task(1), abandoned = s.interrupted(t);
    if (scenario === "revision" && t.state === "awaiting_spec_approval" && t.spec === spec)
      return [{ id: 14, createdAt: when, updatedAt: when, lastEditedAt: null, htmlUrl: "", author: "owner",
        authorId: config.ownerId, body: "/respec use assigned port" }];
    const body = abandoned ? "/resume " + abandoned.id : t.state === "escalated" ? "/reverify " + t.head : "/approve " + t.spec;
    return [{ id: t.state === "escalated" ? 25 : 15, createdAt: when, updatedAt: when, lastEditedAt: null, htmlUrl: "",
      author: "owner", authorId: config.ownerId, body }];
  },
  summary: async () => remote("publish-evidence", { id: 20, htmlUrl: "summary", updated: false }),
  ready: async () => { remote("mark-ready", true); }, reviewBoundary: async () => when,
  pages: async <T>(path: string) => {
    if (path.endsWith("/comments")) {
      if (scenario === "feedback-timeout") {
        if (s.task(1).state !== "done") throw new Error("gate decision was delayed by feedback");
        return new Promise<T[]>(() => {});
      }
      if (scenario === "feedback-denied") throw new Error("fixture inline read refused");
      return [{ id:22,user:{id:config.ownerId},body:"Inline feedback",commit_id:head }] as T[];
    }
    return [{ body:"Review feedback",id:21,user:{id:config.ownerId},state:"APPROVED",commit_id:head,
      submitted_at:"2026-01-02T00:00:00Z" } satisfies Review & { body:string }] as T[];
  },
};
try {
  if (scenario === "feedback-store") s.db.exec("CREATE TRIGGER bad_feedback BEFORE INSERT ON owner_feedback BEGIN SELECT RAISE(ABORT, 'fixture write refused'); END;");
  const final = await runStages(s, initial, {
    git, stateRoot: root, observe: () => {},
    dispatch: async (_s, t, a, role, prompt) => {
      if (role === "reviewer" && scenario === "invalid-verdict") throw new InvalidSkillOutput("wrong spec digest");
      if (role === "reviewer" && scenario === "replacement") throw new Uncertain("skill output integrity escalation: output bytes changed after authenticated final write");
      if (scenario === "login" && a.action === "dispatch-spec") {
        remote(a.action, "login refused", a.id);
        throw new WorkerLoginError("fixture login");
      }
      if (role !== "triage" && scenario === "revision" && t.state === "spec_drafting" &&
          (role !== "spec" || config.agents[role].model !== "claude-opus-5-5" || config.agents[role].effort !== "high"))
        throw Error("the spec and its revision require Opus high");
      const teamHandoff = scenario === "tier-L" ? "tier L, members architect, infra, frontend, threat-modeler" :
        scenario === "security-M" ? "tier M, security flag, member threat-modeler" : null;
      const body = role === "spec" ? teamHandoff ? `BLOCKED: team required, ${teamHandoff}, affects AC-1` : "AC-1 stock" : role === "builder" ? "fixed" : '{"verdict":"approve","rationale":"AC-1 reviewed"}';
      if (role === "reviewer" && (!prompt.includes("base-observation") || !prompt.includes("head-observation")))
        throw Error("reviewer did not see both reproduction results");
      const files = role === "builder" && scenario !== "missing-repro" ? [{ path: "repro.test.ts", content: "eA==" }] : [];
      if (role === "builder" && scenario === "edited-test") files.push({ path: "app.test.ts", content: "eA==" });
      const [path, content] = role === "triage" ? ["triage.json", "{}"] : role === "spec" ? ["spec.md", body] :
        role === "builder" ? ["build-report.json", "{}"] : ["verdicts/code-reviewer.json", '{"verdict":"approve","summary":"AC-1 reviewed"}'];
      const collection = { attempt: a.id, role, round: 1, base: t.base, head: t.head, bundleHash: "fixture",
        files: [{ path, base64: Buffer.from(content).toString("base64"), session: "fixture", role, sha256: "fixture" }] };
      return remote(a.action, { collection, result: { resultText: role === "spec" && teamHandoff ? body : "completed" } as WorkerOutput["result"], files }, a.id);
    },
    test: async (t, a, content) => {
      interruptOnce(a, content ? "resume-base" : "resume-check");
      return remote(a.action, { base: t.base, head: t.head, tested: content ? t.base : t.head,
      checks: [content ? passed("AC-1 fails on base", "base-observation") : scenario === "infra" ?
        { name: "lint", pass: false, detail: "exit 127\nenv: node: No such file or directory" } :
        passed("AC-1 passes on head", "head-observation")] }, a.id);
    },
    verify: async (t, a, prior) => {
      interruptOnce(a, "resume-capture");
      const passes = scenario !== "reverify" || !!s.db.query("SELECT id FROM approvals WHERE reason='owner requested re-verification'").get();
      return remote("verify", { pr: 5, base: t.base, head: t.head, checks: [...prior, { name: "AC-1 capture", pass: passes, detail: "stock" }],
        captures: [], attemptId: a.id, evidenceDir: root }, a.id);
    },
  });
  if (scenario === "crash" && final.state !== "done") throw Error("unexpected state " + final.state);
} finally { s.db.close(); }
