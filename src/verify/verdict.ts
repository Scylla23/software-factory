/**
 * The verdict of a verification attempt: every check is required, and the attempt passes only when all of them do.
 * Nothing is published for an attempt that did not pass (src/github/summary.ts enforces it).
 */

export interface Check {
  /** Short and plain, such as `canary probe` or `before and after differ`; shown in the PR summary. */
  name: string;
  pass: boolean;
  /** Why it passed or failed; may hold untrusted output, so it is only ever shown redacted and fenced. */
  detail: string;
}

/** Older receipts recorded the install timeout under the generic browser check. */
export function retryableVerification(checks: readonly Check[]) {
  const failed = checks.filter(c => !c.pass);
  return failed.length === 1 && (failed[0]!.name === "verification infrastructure" ||
    (failed[0]!.name === "complete browser verification" &&
      /^Error: setup command \d+ \([^()\n]+\) did not succeed: timed_out$/.test(failed[0]!.detail)));
}

export interface Verdict {
  pass: boolean;
  failed: string[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ().,:/-]{0,59}$/;

export function check(name: string, pass: boolean, detail = ""): Check {
  if (!NAME.test(name)) throw new Error(`check name must be short and plain: ${JSON.stringify(name)}`);
  return { name, pass, detail };
}

export function verdict(checks: readonly Check[]): Verdict {
  if (checks.length === 0) return { pass: false, failed: ["no checks ran"] };
  const names = new Set<string>();
  for (const c of checks) {
    if (!NAME.test(c.name)) throw new Error(`check name must be short and plain: ${JSON.stringify(c.name)}`);
    if (names.has(c.name)) throw new Error(`duplicate check ${c.name}`);
    names.add(c.name);
  }
  const failed = checks.filter((c) => !c.pass).map((c) => c.name);
  return { pass: failed.length === 0, failed };
}
