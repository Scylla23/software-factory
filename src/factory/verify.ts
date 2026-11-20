import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config, inventoryFixture } from "../../factory.config";
import type { EvidenceSummary } from "../github/summary";
import { OrcaError } from "../orca/cli";
import { PreviewError } from "../verify/preview";
import { CaptureInfrastructureError, withVerificationProfile } from "../verify/browser";
import { commandCheck, teardownCheck } from "../verify/checks";
import { VIEWPORTS, type EvidenceRecord } from "../verify/evidence";
import { type EvidenceStore, openEvidenceStore } from "../verify/store";
import { check, type Check, verdict } from "../verify/verdict";
import type { ProjectChecks } from "./checks";
import type { Attempt, Task } from "./store";
import { Uncertain } from "./machine";

const inventory = config.pilot.fixtures.inventory;
export function inventoryMatches(
  text: string,
  stage: "before" | "after",
  rows: readonly { name: string; before: string; after: string }[] = inventory.rows,
  heading?: { before: string; after: string },
) {
  // Orca's reader keeps row boundaries but may concatenate adjacent table cells.
  const lines = text.split(/\r?\n/).map((s) => s.replace(/\|/g, " ").trim().replace(/\s+/g, " "));
  if (heading) {
    const headers = lines.filter(line => line.startsWith("Item"));
    if (headers.length !== 1 || headers[0]!.slice(4).trim() !== heading[stage]) return false;
  }
  return rows.every((row) => {
    const cells = lines.filter((line) => line.startsWith(row.name));
    return cells.length === 1 && cells[0]?.slice(row.name.length).trim() === row[stage];
  });
}

export async function verifyPilot(
  task: Task,
  attempt: Attempt,
  project: ProjectChecks,
  prior: Check[],
): Promise<EvidenceSummary> {
  const fixture = inventoryFixture(task.issue.number);
  if (task.issue.number !== fixture.issue) throw new Error("no registered verification fixture for this issue");
  const dir = join(project.stateRoot, "evidence", attempt.id);
  if (!attempt.fresh && existsSync(dir)) {
    const receipt = join(dir, "records.json");
    if (!existsSync(receipt)) throw new Uncertain(`interrupted browser capture ${attempt.id}`);
    const stored = JSON.parse(readFileSync(receipt, "utf8")) as EvidenceSummary;
    if (
      stored.attemptId !== attempt.id ||
      stored.pr !== task.pr ||
      stored.base !== task.base ||
      stored.head !== task.head ||
      stored.evidenceDir !== dir
    )
      throw new Uncertain("browser capture receipt moved");
    return stored;
  }
  const evidence: EvidenceStore = openEvidenceStore(project.stateRoot, attempt.id);
  const checks = [...prior];
  const captures: EvidenceRecord[] = [];
  try {
    await withVerificationProfile(
      { attemptId: attempt.id, orcaPath: project.verify.executables.orca, worktree: `path:${config.pilot.path}` },
      async (browser) => {
        const session = await browser.sessionAt(`https://github.com/${config.pilot.owner}/${config.pilot.repo}/pull/${task.pr}`);
        checks.push(check("verification profile signed out", !session.signedIn));
        for (const phase of ["before", "after"] as const) {
          const sha = phase === "before" ? task.base : task.head;
          await project.preview(task, attempt.id, sha, phase, checks, async (p) => {
            const expected = inventory.rows.map(({ name, count }) => ({ name, count }));
            const api = await p.run(
              [
                "bun",
                "-e",
                "const r=await fetch(process.argv[1]);const body=await r.json();console.log(JSON.stringify(body));if(r.status!==200||JSON.stringify(body)!==process.argv[2])process.exit(1)",
                p.origin + inventory.api,
                JSON.stringify(expected),
              ],
              { name: "inventory-api", timeoutMs: 10_000, network: "serve" },
            );
            checks.push(commandCheck(`AC-1 ${phase} inventory API`, api));
            for (const viewport of Object.values(VIEWPORTS)) {
              const name = `${phase}-${viewport.name}`;
              const record = await browser.capture({
                url: p.origin + inventory.path,
                viewport,
                store: evidence,
                name,
                acId: "AC-1",
                commitSha: sha,
                serving: p.serving,
              });
              captures.push(record);
              checks.push(
                check(
                  `AC-1 ${name} stock counts`,
                  !record.truncated.pageText && inventoryMatches(record.pageText, phase, fixture.rows, fixture.heading),
                  record.pageText,
                ),
              );
              checks.push(
                check(
                  `${name} browser diagnostics`,
                  !record.consoleErrors.length &&
                    !record.networkFailures.length &&
                    !record.truncated.console &&
                    !record.truncated.network,
                  JSON.stringify({ errors: record.consoleErrors, failures: record.networkFailures }),
                ),
              );
            }
            captures.push(
              await browser.capture({
                url: p.origin + inventory.api,
                viewport: VIEWPORTS.desktop,
                store: evidence,
                name: `${phase}-api`,
                acId: "AC-1",
                commitSha: sha,
                serving: p.serving,
              }),
            );
          });
        }
        for (const v of Object.values(VIEWPORTS)) {
          const a = captures.find((r) => r.name === `before-${v.name}`);
          const b = captures.find((r) => r.name === `after-${v.name}`);
          checks.push(check(`AC-1 visible change ${v.name}`, !!a && !!b && a.screenshotSha256 !== b.screenshotSha256));
        }
      },
    );
  } catch (e) {
    if (e instanceof PreviewError && e.teardown) checks.push(teardownCheck("preview start teardown", e.teardown));
    const retryable = e instanceof CaptureInfrastructureError || e instanceof OrcaError ||
      (e instanceof PreviewError && e.retryableStart);
    checks.push(check(retryable ? "verification infrastructure" : "complete browser verification", false, String(e)));
  }
  const result = {
    pr: task.pr,
    attemptId: attempt.id,
    base: task.base,
    head: task.head,
    checks,
    captures,
    evidenceDir: evidence.dir,
  };
  evidence.putJson("checks.json", { verdict: verdict(checks), checks });
  const receipt = evidence.putJson("completed-records.json", result);
  renameSync(receipt.path, join(evidence.dir, "records.json"));
  return result;
}
