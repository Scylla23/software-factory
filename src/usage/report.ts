import type { Database } from "bun:sqlite";
import { config } from "../../factory.config";
import type { Capture, Line } from "./capture";
import { legacyCapture, modelFlag } from "./store";

export const dimensions = ["task", "project", "model", "stage"] as const;
export type Dimension = typeof dimensions[number];
const priceLabel = "API-equivalent estimate (USD)";

type Audit = {
  attempt: string; task: number; stage: string; requested_model: string; observed_model: string | null;
  outcome: string; usage: string | null; repo_id: number; capture: string | null; model_flag: string | null;
};
type Coverage = Capture["coverage"];
interface Totals {
  runs: number;
  tokens: number | null;
  apiEquivalentUsd: number | null;
  tokenCoverage: Coverage;
  costCoverage: Coverage;
}
const empty = (): Totals => ({ runs: 0, tokens: null, apiEquivalentUsd: null, tokenCoverage: "unknown", costCoverage: "unknown" });

function coverage(a: Coverage, b: Coverage): Coverage {
  return a === b ? a : "partial";
}

function add(t: Totals, lines: Line[], usd: number | null, state: Coverage, reportedTotal: boolean) {
  const tokens = lines.length ? lines.reduce((sum, l) => sum + l.input + l.cacheRead + (l.cacheWrite ?? 0) + l.output, 0) : null;
  const costs = lines.flatMap(l => l.costUsd === null ? [] : [l.costUsd]);
  const knownCost = usd ?? (costs.length ? costs.reduce((a,b) => a + b, 0) : null);
  const tokenState = tokens === null ? "unknown" : state;
  const costState = reportedTotal && usd !== null ? "complete" : knownCost === null ? "unknown" : usd === null && costs.length !== lines.length ? "partial" : state;
  t.tokenCoverage = t.runs ? coverage(t.tokenCoverage, tokenState) : tokenState;
  t.costCoverage = t.runs ? coverage(t.costCoverage, costState) : costState;
  if (tokens !== null) t.tokens = (t.tokens ?? 0) + tokens;
  if (knownCost !== null) t.apiEquivalentUsd = (t.apiEquivalentUsd ?? 0) + knownCost;
  t.runs++;
}

function hasCaptures(db: Database) {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_captures'").get();
}

function totalsBy(db: Database, by: Dimension) {
  const groups = new Map<string | number, Totals>();
  const flags: { task: number; attempt: string; flag: string; requested: string; observed: string | null }[] = [];
  const migrated = hasCaptures(db);
  const rows = db.query<Audit, []>(`SELECT a.*,t.repo_id,${migrated ? "u.capture,u.model_flag" : "NULL AS capture,NULL AS model_flag"}
    FROM audit a JOIN tasks t ON t.id=a.task ${migrated ? "LEFT JOIN usage_captures u USING(attempt)" : ""} ORDER BY a.task,a.rowid`).all();
  function accumulate(key: string | number, lines: Line[], cost: number | null, state: Coverage, reportedTotal: boolean) {
    const group = groups.get(key) ?? empty();
    add(group, lines, cost, state, reportedTotal);
    groups.set(key, group);
  }
  for (const r of rows) {
    const capture: Capture = r.capture ? JSON.parse(r.capture) : legacyCapture(r.usage, r.observed_model, r.outcome);
    const flag = r.model_flag ?? modelFlag(r.requested_model, r.observed_model);
    if (flag !== "match") flags.push({ task: r.task, attempt: r.attempt, flag, requested: r.requested_model, observed: r.observed_model });
    if (by === "model") {
      const billed = new Map<string, Line[]>();
      for (const l of capture.lines) {
        const key = l.model ?? "unknown";
        const bucket = billed.get(key) ?? [];
        bucket.push(l);
        billed.set(key,bucket);
      }
      if (!billed.size) billed.set(r.observed_model ?? "unknown", []);
      for (const [key, lines] of billed) accumulate(key, lines, billed.size === 1 ? capture.costUsd : null, capture.coverage, billed.size === 1 && capture.reportedTotal);
    } else {
      const project = r.repo_id === config.pilot.repoId ? config.pilot.owner + "/" + config.pilot.repo : String(r.repo_id);
      accumulate(by === "task" ? r.task : by === "stage" ? r.stage : project, capture.lines, capture.costUsd, capture.coverage, capture.reportedTotal);
    }
  }
  return { groups, flags };
}

function signals(db: Database) {
  const escalations = db.query("SELECT task,visit,reason FROM transitions WHERE state='escalated' ORDER BY task,visit").all();
  const retries = db.query(`WITH numbered AS (SELECT task,id AS attempt,visit,action,
    row_number() OVER (PARTITION BY task,replace(action,'-after-login','') ORDER BY visit,rowid) AS ordinal FROM attempts)
    SELECT task,attempt,visit,action,ordinal FROM numbered WHERE ordinal>1 ORDER BY task,visit,action`).all();
  const feedback = hasCaptures(db) ? "UNION SELECT task,kind,id FROM owner_feedback" : "";
  type Ref = { task: number; kind: string; id: number; issue_url: string; pr: number };
  const comments = db.query<Ref, [number]>(`WITH refs AS (SELECT task,kind,id FROM approvals WHERE actor=? ${feedback})
    SELECT refs.*,json_extract(t.issue,'$.url') AS issue_url,t.pr FROM refs JOIN tasks t ON t.id=refs.task ORDER BY refs.task,kind,id`).all(config.ownerId);
  const ownerComments = comments.map(r => {
    const pr = String(r.issue_url).replace(/\/issues\/\d+\/?$/, "/pull/" + r.pr);
    const anchor = r.kind === "inline" ? "discussion_r" : r.kind === "review" ? "pullrequestreview-" : "issuecomment-";
    return { task: r.task, kind: r.kind, id: r.id, url: pr + "#" + anchor + r.id };
  });
  return { retries, escalations, ownerComments };
}

export function costReport(db: Database | null, by: Dimension) {
  const { groups, flags } = db ? totalsBy(db, by) : { groups: new Map(), flags: [] };
  return { by, costLabel: priceLabel, groups: Array.from(groups, ([key, totals]) => ({ [by]: key, ...totals })),
    modelFlags: flags, signals: db ? signals(db) : { retries: [], escalations: [], ownerComments: [] } };
}

export function statusReport(db: Database | null) {
  if (!db) return [];
  const { groups } = totalsBy(db, "task");
  return db.query<{ id: number; state: string; visit: number; pr: number; spec: string; head: string; reason: string }, []>("SELECT id,state,visit,pr,spec,head,reason FROM tasks ORDER BY id").all().map(row => ({
    ...row, ...(groups.get(Number(row.id)) ?? empty()), costLabel: priceLabel,
  }));
}
