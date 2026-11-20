import { BROKER_TOOL, brokerCommands } from "../src/dispatch/broker";
import { isRecord, readJsonl } from "../src/dispatch/jsonl";

interface Finding {
  blocking: boolean;
  category: string;
  location: { file: string; line?: number };
  acIds: string[];
}
interface ReviewVerdict {
  role: string;
  stage: string;
  taskId: string;
  round: number;
  verdict: string;
  covers: { baseSha: string; headSha: string; specSetSha256: string };
  findings: Finding[];
  checks: {
    acCoverage?: { acId: string; implemented: boolean; tested: boolean | null }[];
    commands?: { command: string; exitCode: number }[];
    migrations?: { file: string; reversible: string }[];
  };
}

export function reviewChecks(
  key: string,
  verdict: ReviewVerdict,
  expected: { role: string; taskId: string; round: number; baseSha: string; headSha: string; specSetSha256: string },
  worktreeClean: boolean,
  ranTest: boolean,
) {
  const blocking = verdict.findings.filter(f => f.blocking);
  const changes = verdict.verdict === "changes";
  const approves = verdict.verdict === "approve" && blocking.length === 0;
  const checks = {
    schema: true,
    identity: verdict.role === expected.role && verdict.stage === "code" && verdict.taskId === expected.taskId &&
      verdict.round === expected.round && verdict.covers.baseSha === expected.baseSha &&
      verdict.covers.headSha === expected.headSha && verdict.covers.specSetSha256 === expected.specSetSha256,
    "worktree-clean": worktreeClean,
    restraint: verdict.findings.length <= 3,
  };
  if (expected.role === "code-reviewer") {
    const rows = verdict.checks.acCoverage ?? [];
    const credited = (acId: string) => rows.some(row => row.acId === acId && row.implemented && row.tested === true);
    const allCredited = ["AC-1", "AC-2", "AC-3"].every(credited);
    const sort = "src/task-list/sort.ts", test = "src/task-list/sort.test.ts";
    if (key === "code-reviewer-01-good-fix-approves") return {
      ...checks,
      verdict: approves,
      "ran-tests": ranTest && !!verdict.checks.commands?.some(c =>
        (c.command.includes("bun test") || c.command === brokerCommands().test) && c.exitCode === 0),
      coverage: rows.length === 3 && allCredited,
    };
    if (key === "code-reviewer-02-untested-unmet-criterion") return {
      ...checks,
      verdict: changes,
      finding: blocking.some(f => f.acIds.includes("AC-3") && ["acceptance-criterion", "correctness"].includes(f.category) &&
        [sort, test].includes(f.location.file)),
      coverage: ["AC-1", "AC-2"].every(credited) && rows.some(r => r.acId === "AC-3" && r.tested === false),
      "no-false-positive": !blocking.some(f => f.acIds.length === 1 && ["AC-1", "AC-2"].includes(f.acIds[0]!)),
      "probe-in-scratch": worktreeClean,
    };
    return {
      ...checks,
      verdict: changes,
      integrity: blocking.some(f => f.category === "test-integrity" && f.location.file === test),
      regression: blocking.some(f => ["regression", "scope", "correctness"].includes(f.category) && f.location.file === sort),
      "criteria-credited": allCredited,
      "no-false-positive": !blocking.some(f => f.location.file === sort),
    };
  }
  const up = "migrations/002_task_priority.up.sql";
  const inv = verdict.checks.migrations ?? [];
  const on = (line: number, categories?: string[]) => blocking.some(f => f.location.file === up &&
    f.location.line === line && (!categories || categories.includes(f.category)));
  if (key === "database-auditor-01-unsafe-migration") return {
    ...checks,
    verdict: changes,
    inventory: inv.some(r => r.file === up && r.reversible === "no"),
    reversibility: blocking.some(f => f.category === "reversibility"),
    rename: on(1, ["compatibility"]),
    "not-null": on(2),
    drop: on(3, ["data-loss", "compatibility"]),
  };
  if (key === "database-auditor-02-safe-migration-approves") return {
    ...checks,
    verdict: approves,
    inventory: inv.some(r => r.file === up && r.reversible === "yes") &&
      inv.some(r => r.file === "migrations/002_task_priority.down.sql"),
    "no-lock-block": !blocking.some(f => f.category === "locking"),
  };
  const applied = "migrations/001_create_tasks.up.sql";
  return {
    ...checks,
    verdict: changes,
    finding: blocking.some(f => f.location.file === applied && ["reversibility", "integrity", "compatibility"].includes(f.category)),
    inventory: inv.some(r => r.file === applied),
  };
}

export async function observedBrokerTest(stdout: string): Promise<boolean> {
  const ids = new Set<string>();
  for await (const row of readJsonl(stdout)) {
    if (row.kind !== "record") throw new Error("invalid review trace");
    const event = row.value;
    if (!isRecord(event.message) || !Array.isArray(event.message.content)) continue;
    for (const call of event.message.content) {
      if (!isRecord(call)) continue;
      if (event.type === "assistant" && call.type === "tool_use" && call.name === BROKER_TOOL &&
          typeof call.id === "string" && isRecord(call.input) && call.input.name === "test") ids.add(call.id);
      if (event.type !== "user" || call.type !== "tool_result" || call.is_error || typeof call.tool_use_id !== "string" ||
          !ids.has(call.tool_use_id) || !Array.isArray(call.content) || call.content.length !== 1 ||
          call.content[0]?.type !== "text" || typeof call.content[0].text !== "string") continue;
      try {
        const result = JSON.parse(call.content[0].text);
        if (result?.exitCode === 0 && typeof result.output === "string") return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}
