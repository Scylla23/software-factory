import { userInfo } from "node:os";
import { isRecord } from "../dispatch/jsonl";

/** Bound on one `orca` call; the CLI answers in about a second when the runtime is up. */
export const ORCA_TIMEOUT_MS = 15_000;

/** `orca` gets a fixed minimal env: it finds its runtime from HOME, and nothing of the factory's env leaks into it. */
function orcaEnv(): Record<string, string> {
  const u = userInfo();
  return { HOME: u.homedir, USER: u.username, LOGNAME: u.username, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" };
}

/**
 * A failed `orca` call. `uncertain` is true when the command may still have taken effect (a timeout, a nonzero exit, or
 * output that cannot be read), so a caller that created something must reconcile; false for a clean `ok: false`.
 */
export class OrcaError extends Error {
  constructor(message: string, readonly uncertain: boolean) {
    super(message);
  }
}

/**
 * Runs `<orcaPath> <args> --json` and returns `result`.
 * Rejects on spawn failure, timeout, unparsable output, `ok: false`, or a nonzero exit even with an ok envelope.
 */
export async function orcaJson(orcaPath: string, args: readonly string[], timeoutMs = ORCA_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const what = `orca ${args.slice(0, 2).join(" ")}`;
  const proc = Bun.spawn([orcaPath, ...args, "--json"], { env: orcaEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timer: Timer | undefined;
  // Raced rather than awaited after a kill: a grandchild could hold the pipes open long after orca dies.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new OrcaError(`${what}: no answer within ${timeoutMs}ms`, true));
    }, timeoutMs);
  });
  try {
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
      timeout,
    ]);
    let out: unknown;
    try {
      out = JSON.parse(stdout);
    } catch {
      throw new OrcaError(`${what}: exit ${code}, unparsable output: ${stderr.trim().slice(0, 300)}`, true);
    }
    if (isRecord(out) && out.ok === false) {
      throw new OrcaError(`${what} failed: ${JSON.stringify(out.error).slice(0, 300)}`, false);
    }
    if (code !== 0) throw new OrcaError(`${what}: exit ${code} despite an ok envelope: ${stderr.trim().slice(0, 300)}`, true);
    if (!isRecord(out) || out.ok !== true || !isRecord(out.result)) {
      throw new OrcaError(`${what}: unexpected envelope: ${JSON.stringify(out).slice(0, 300)}`, true);
    }
    return out.result;
  } finally {
    clearTimeout(timer);
  }
}
