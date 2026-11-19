/**
 * Checks built from what a verification attempt observed. Each keeps the observation's own status (a probe's exit
 * code, a teardown's report, the screenshot hashes) so the verdict, not a log reader, decides whether it passed.
 */
import type { EvidenceRecord, Viewport } from "./evidence";
import { type CommandResult, tail, type TeardownReport } from "./preview";
import { type Check, check } from "./verdict";

/** Log bytes kept as a check's detail. */
const DETAIL_BYTES = 800;

/** A probe passes only on its own exit 0, run to completion, leaving nothing behind (the probes exit 1 on a leak, 2 when inconclusive). */
export function commandCheck(name: string, r: CommandResult): Check {
  const status = r.stopped ?? (r.exitCode === null ? "killed by a signal" : `exit ${r.exitCode}`);
  const left = r.quarantineReasons.length > 0 ? `; left behind: ${r.quarantineReasons.join("; ")}` : "";
  const pass = r.stopped === null && r.exitCode === 0 && r.quarantineReasons.length === 0;
  return check(name, pass, `${status}${left}\n${tail(r.logPath, DETAIL_BYTES)}`);
}

/** A preview's teardown passes when it removed everything it made and nothing may still run. */
export function teardownCheck(name: string, t: TeardownReport): Check {
  const pass = t.removed && t.noKnownSurvivors && t.quarantineReasons.length === 0;
  return check(name, pass, `removed ${t.removed}, no known survivors ${t.noKnownSurvivors}${t.quarantineReasons.length ? `; ${t.quarantineReasons.join("; ")}` : ""}`);
}

export interface CaptureRuns {
  /** Two captures of the base commit, one per viewport each, to show a capture is repeatable. */
  first: readonly EvidenceRecord[];
  second: readonly EvidenceRecord[];
  /** One capture of the head commit per viewport. */
  after: readonly EvidenceRecord[];
  viewports: readonly Viewport["name"][];
  /** Text the head commit adds to the page and the base commit lacks. */
  expectedChange: string;
  /** A console error the page plants on purpose, so a capture that saw none missed it. */
  plantedConsoleError: string;
}

/**
 * Per viewport: the base captures match each other, the head capture differs from them, the expected text is on the
 * head page only, and every capture saw the planted console error.
 */
export function captureChecks(c: CaptureRuns): Check[] {
  const out: Check[] = [];
  const at = (runs: readonly EvidenceRecord[], vp: string) => runs.filter((r) => r.viewport.name === vp);
  for (const vp of c.viewports) {
    const [a, b, h] = [at(c.first, vp), at(c.second, vp), at(c.after, vp)];
    if (a.length !== 1 || b.length !== 1 || h.length !== 1) {
      out.push(check(`captures complete (${vp})`, false, `base ${a.length}, base again ${b.length}, head ${h.length}; one each expected`));
      continue;
    }
    const [x, y, z] = [a[0]!, b[0]!, h[0]!];
    out.push(check(`base capture repeatable (${vp})`, x.screenshotSha256 === y.screenshotSha256, `${x.screenshotSha256} vs ${y.screenshotSha256}`));
    out.push(check(`base and head differ (${vp})`, x.screenshotSha256 !== z.screenshotSha256 && y.screenshotSha256 !== z.screenshotSha256, `head ${z.screenshotSha256}`));
    const before = [x, y].filter((r) => r.pageText.includes(c.expectedChange)).length;
    const after = z.pageText.includes(c.expectedChange);
    out.push(check(`change on head only (${vp})`, before === 0 && after, `on ${before} of 2 base captures, ${after ? "on" : "not on"} the head capture`));
    const missed = [x, y, z].filter((r) => !r.consoleErrors.some((e) => e.includes(c.plantedConsoleError))).map((r) => r.name);
    out.push(check(`planted console error seen (${vp})`, missed.length === 0, missed.length ? `missed by ${missed.join(", ")}` : ""));
  }
  return out;
}
