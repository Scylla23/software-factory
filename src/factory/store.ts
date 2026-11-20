import type { EvidenceSummary } from "../github/summary";
import { retryableVerification, verdict } from "../verify/verdict";
import { migrateSkillStore } from "./skill-store";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { migrateFeedbackFailures, migrateUsage } from "../usage/store";
import { config } from "../../factory.config";

export interface Issue {
  /** Factory assignment frozen at intake. Older task snapshots used repro.test.ts. */
  reproductionFile?: string;
  source: "github";
  repoId: number;
  issueId: number;
  number: number;
  title: string;
  body: string;
  sender: number;
  revision: string;
  url: string;
}

function assignedReproduction(number: number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("invalid issue number for reproduction");
  return `repro-issue-${number}.test.ts`;
}
export function reproductionFile(issue: Issue) {
  if (issue.reproductionFile === undefined) return "repro.test.ts";
  const file = assignedReproduction(issue.number);
  if (file !== issue.reproductionFile) throw new Error("invalid stored reproduction assignment");
  return file;
}

export const edges = {
  received: ["spec_drafting"],
  spec_drafting: ["awaiting_spec_approval"],
  awaiting_spec_approval: ["spec_drafting", "building"],
  building: ["checks"],
  checks: ["building", "code_review"],
  code_review: ["building", "verifying"],
  verifying: ["building", "awaiting_pr_approval"],
  awaiting_pr_approval: ["done"],
  done: [],
  failed: [],
  escalated: ["verifying"],
} as const;
export type State = keyof typeof edges;
export interface Task {
  id: number;
  state: State;
  visit: number;
  issue: Issue;
  base: string;
  head: string;
  spec: string;
  pr: number;
  repairCount: number;
  reason: string;
}
export type Update = Partial<Pick<Task, "base" | "head" | "spec" | "pr" | "reason" | "repairCount">>;
export interface Attempt {
  validationFeedback?: string;
  id: string;
  action: string;
  result: string | null;
  fresh: boolean;
}
export interface Approval {
  kind: "comment" | "review";
  id: number;
  actor: number;
  sha: string;
  accepted: boolean;
  reason: string;
}

export class Store {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db
      .transaction(() => {
        const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
        if (version === 4) return;
        if (version === 2 && !this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_captures'").get()) {
          // Step 4b's pre-merge v2 contained skills and predated usage accounting.
          const skills = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('skill_tasks','skill_collections','skill_files')").all();
          if (skills.length !== 3) throw new Error("unrecognized v2 factory schema");
          migrateUsage(this.db);
          this.db.exec("PRAGMA user_version=4");
          return;
        }
        if (version === 1 || version === 2 || version === 3) {
          if (version === 1) migrateUsage(this.db);
          if (version === 2) migrateFeedbackFailures(this.db);
          return migrateSkillStore(this.db);
        }
        if (version !== 0) throw new Error(`unsupported factory database version ${version}`);
        this.db.exec(`
        CREATE TABLE tasks (id INTEGER PRIMARY KEY, source TEXT NOT NULL, repo_id INTEGER NOT NULL,
          issue_id INTEGER NOT NULL, issue TEXT NOT NULL, state TEXT NOT NULL, visit INTEGER NOT NULL DEFAULT 0,
          base TEXT NOT NULL, head TEXT NOT NULL, spec TEXT NOT NULL DEFAULT '', pr INTEGER NOT NULL DEFAULT 0,
          repairCount INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '', UNIQUE(source,repo_id,issue_id));
        CREATE TABLE transitions (task INTEGER NOT NULL REFERENCES tasks, visit INTEGER NOT NULL, previous TEXT,
          state TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(task,visit));
        CREATE TABLE attempts (id TEXT PRIMARY KEY, task INTEGER NOT NULL, visit INTEGER NOT NULL,
          action TEXT NOT NULL, intent TEXT NOT NULL, result TEXT, UNIQUE(task,visit,action),
          FOREIGN KEY(task,visit) REFERENCES transitions(task,visit));
        CREATE TABLE approvals (task INTEGER NOT NULL REFERENCES tasks, kind TEXT NOT NULL, id INTEGER NOT NULL,
          actor INTEGER NOT NULL, sha TEXT NOT NULL, accepted INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(kind,id));
        CREATE TABLE factory_comments (id INTEGER PRIMARY KEY, task INTEGER NOT NULL REFERENCES tasks);
        CREATE TABLE audit (attempt TEXT PRIMARY KEY REFERENCES attempts, task INTEGER NOT NULL REFERENCES tasks,
          stage TEXT NOT NULL, session TEXT, requested_model TEXT NOT NULL, observed_model TEXT, effort TEXT NOT NULL,
          prompt_revision TEXT NOT NULL, base TEXT NOT NULL, head TEXT NOT NULL, outcome TEXT NOT NULL, usage TEXT);
        PRAGMA user_version=1;
      `);
        migrateUsage(this.db);
        migrateSkillStore(this.db);
      })
      .immediate();
  }

  private write<T>(operation: () => T): T {
    let result!: T;
    this.db
      .transaction(() => {
        result = operation();
      })
      .immediate();
    return result;
  }

  intake(issue: Issue, base: string): Task {
    return this.write(() => {
      const row = this.db
        .query<{ id: number }, [string, number, number]>("SELECT id FROM tasks WHERE source=? AND repo_id=? AND issue_id=?")
        .get(issue.source, issue.repoId, issue.issueId);
      if (row) return this.task(row.id);
      const { lastInsertRowid } = this.db.run(
        "INSERT INTO tasks(source,repo_id,issue_id,issue,state,base,head) VALUES(?,?,?,?,'received',?,?)",
        [issue.source, issue.repoId, issue.issueId, JSON.stringify({...issue, reproductionFile: assignedReproduction(issue.number)}), base, base],
      );
      const id = Number(lastInsertRowid);
      this.db.run("INSERT INTO transitions(task,visit,state,reason) VALUES(?,0,'received','owner-authorized issue')", [id]);
      return this.task(id);
    });
  }

  task(id: number): Task {
    const raw = this.db
      .query<Omit<Task, "issue"> & { issue: string }, [number]>(
        "SELECT id,state,visit,issue,base,head,spec,pr,repairCount,reason FROM tasks WHERE id=?",
      )
      .get(id);
    if (!raw) throw new Error(`unknown factory task ${id}`);
    return { ...raw, issue: JSON.parse(raw.issue) };
  }

  verificationReceipt(task: Task, visit: number) {
    const row = this.db.query<{id: string; result: string | null}, [number, number]>(
      "SELECT id,result FROM attempts WHERE task=? AND visit=? AND action IN ('verify','verify-infra-retry') " +
      "ORDER BY CASE action WHEN 'verify-infra-retry' THEN 0 ELSE 1 END LIMIT 1").get(task.id, visit);
    if (!row?.result) return null;
    const receipt: EvidenceSummary = JSON.parse(row.result);
    return receipt.attemptId === row.id && receipt.base === task.base && receipt.head === task.head &&
      receipt.pr === task.pr && Array.isArray(receipt.checks) ? receipt : null;
  }

  canReverify(task: Task): boolean {
    const persisted = this.task(task.id);
    if (
      task.state !== "escalated" ||
      persisted.visit !== task.visit ||
      persisted.state !== "escalated" ||
      persisted.pr !== task.pr ||
      persisted.head !== task.head ||
      persisted.base !== task.base
    )
      return false;
    const previous = this.db
      .query<{ previous: string }, [number, number]>("SELECT previous FROM transitions WHERE task=? AND visit=?")
      .get(task.id, task.visit);
    const reviewed = this.db
      .query<{ result: string }, [number]>(
        "SELECT result FROM attempts WHERE task=? AND action IN ('code-review','code-review-validation-retry') AND result IS NOT NULL ORDER BY visit DESC LIMIT 1",
      )
      .get(task.id);
    if (previous?.previous !== "verifying" || !reviewed) return false;
    const receipt = this.verificationReceipt(persisted, persisted.visit - 1);
    if (!receipt || !receipt.checks.length || verdict(receipt.checks).pass) return false;
    if (!persisted.reason.startsWith("failed verification:") &&
        !(persisted.reason.startsWith("factory infrastructure failed during ") && retryableVerification(receipt.checks))) return false;
    const result = JSON.parse(reviewed.result);
    return result.base === persisted.base && result.head === persisted.head && result.verdict === "approve";
  }

  interrupted(task: Task) {
    const saved = this.task(task.id);
    if (saved.state !== "escalated" || saved.visit !== task.visit || saved.head !== task.head) return null;
    const match = /^interrupted (project check|browser capture) ([0-9a-f-]{36})$/.exec(saved.reason);
    if (!match) return null;
    const row = this.db.query<{ id: string; action: string; state: State; reason: string }, [string, number, number]>(
      "SELECT a.id,a.action,t.state,t.reason FROM attempts a JOIN transitions t USING(task,visit) " +
      "WHERE a.id=? AND a.task=? AND a.visit=? AND a.result IS NULL").get(match[2]!, task.id, task.visit - 1);
    if (!row) return null;
    const valid = match[1] === "browser capture" ? (row.action === "verify" || row.action === "verify-infra-retry") && row.state === "verifying" :
      (row.action === "base-reproduction" && row.state === "building") || (row.action === "head-checks" && row.state === "checks");
    return valid ? row : null;
  }

  requireSlot(issue: Issue) {
    const busy = this.db
      .query<{ id: number; state: State }, [string, number, number]>(
        "SELECT id,state FROM tasks WHERE state IN ('received','spec_drafting','building','checks','code_review','verifying') " +
          "AND NOT (source=? AND repo_id=? AND issue_id=?) LIMIT 1",
      )
      .get(issue.source, issue.repoId, issue.issueId);
    if (busy) throw new Error(`resume task ${busy.id} in ${busy.state} before starting another task`);
  }

  move(task: Task, state: State, update: Update = {}, approval?: Approval): Task {
    const resume = task.state === "escalated" ? this.interrupted(task) : null;
    const restoring = resume && state === resume.state && approval?.reason === `resume interrupted attempt ${resume.id}`;
    if (["done", "failed"].includes(task.state) || (!restoring && (task.state === "escalated" ? state !== "verifying" :
        !(edges[task.state] as readonly State[]).includes(state) && state !== "escalated" && state !== "failed")))
      throw new Error(`invalid transition ${task.state} -> ${state}`);
    return this.write(() => {
      if (task.state === "escalated") {
        if (
          (!restoring && (!this.canReverify(task) || approval?.reason !== "owner requested re-verification")) ||
          (restoring && update.reason !== resume.reason) ||
          Object.keys(update).some((k) => k !== "reason") ||
          approval?.kind !== "comment" || approval.actor !== config.ownerId ||
          approval.sha !== task.head || approval.accepted
        ) throw new Error("missing owner resolution for failed verification or interrupted check");
      }
      if ((task.state === "awaiting_spec_approval" && state === "building") || state === "done") {
        const final = state === "done";
        if (
          !approval?.accepted ||
          approval.actor !== config.ownerId ||
          approval.kind !== (final ? "review" : "comment") ||
          !approval.sha ||
          approval.sha !== (final ? task.head : task.spec)
        )
          throw new Error("missing bound owner approval");
      }
      const next = { ...task, reason: "", ...update };
      const changed = this.db.run(
        "UPDATE tasks SET visit=visit+1,state=?,base=?,head=?,spec=?,pr=?,repairCount=?,reason=? WHERE id=? AND visit=?",
        [state, next.base, next.head, next.spec, next.pr, next.repairCount, next.reason, task.id, task.visit],
      );
      if (!changed.changes) throw new Error("concurrent task transition");
      if (approval && !this.record(task.id, approval)) throw new Error("approval already consumed");
      this.db.run("INSERT INTO transitions(task,visit,previous,state,reason) VALUES(?,?,?,?,?)", [
        task.id,
        task.visit + 1,
        task.state,
        state,
        next.reason,
      ]);
      return this.task(task.id);
    });
  }

  record(task: number, event: Approval): boolean {
    return (
      this.db.run("INSERT OR IGNORE INTO approvals VALUES(?,?,?,?,?,?,?)", [
        task,
        event.kind,
        event.id,
        event.actor,
        event.sha,
        Number(event.accepted),
        event.reason,
      ]).changes === 1
    );
  }

  plan(task: Task, action: string, intent: unknown): Attempt {
    const json = JSON.stringify(intent);
    return this.write(() => {
      if (this.task(task.id).visit !== task.visit) throw new Error("attempt on a stale transition");
      // Only the base proof can interrupt a building visit after its builder already completed.
      // Reuse that exact dispatch, including its original UUID and audit, across repeated owner-authorized restarts.
      if (action === "dispatch-builder" && this.db.query("SELECT 1 FROM transitions WHERE task=? AND visit=? AND previous='escalated' AND state='building'").get(task.id, task.visit)) {
        const saved = this.db.query<{ id: string; result: string; intent: string }, [number, number]>(
          "SELECT id,result,intent FROM attempts WHERE task=? AND visit<? AND action IN ('dispatch-builder','dispatch-builder-validation-retry') AND result IS NOT NULL ORDER BY visit DESC LIMIT 1"
        ).get(task.id, task.visit);
        if (!saved || saved.intent !== json) throw new Error("interrupted base proof lost its completed builder");
        return { id: saved.id, result: saved.result, action, fresh: false };
      }
      const id = randomUUID();
      const fresh =
        this.db.run("INSERT OR IGNORE INTO attempts(id,task,visit,action,intent) VALUES(?,?,?,?,?)", [
          id,
          task.id,
          task.visit,
          action,
          json,
        ]).changes === 1;
      const row = this.db
        .query<{ id: string; intent: string; result: string | null }, [number, number, string]>(
          "SELECT id,intent,result FROM attempts WHERE task=? AND visit=? AND action=?",
        )
        .get(task.id, task.visit, action);
      if (!row) throw new Error("attempt intention was not persisted");
      if (row.intent !== json) throw new Error("attempt intent changed on restart");
      return { id: row.id, result: row.result, action, fresh };
    });
  }

  finish(id: string, value: unknown) {
    const result = this.db.run("UPDATE attempts SET result=? WHERE id=? AND result IS NULL", [JSON.stringify(value), id]);
    if (!result.changes) throw new Error(`attempt already settled or missing: ${id}`);
  }
}
