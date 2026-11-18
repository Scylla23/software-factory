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
 * Runs `<orcaPath> <args> --json` and returns `result`.
 * Rejects on spawn failure, timeout, a nonzero exit, unparsable output, or `ok: false`.
 */
export async function orcaJson(orcaPath: string, args: readonly string[], timeoutMs = ORCA_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const what = `orca ${args.slice(0, 2).join(" ")}`;
  const proc = Bun.spawn([orcaPath, ...args, "--json"], { env: orcaEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timer: Timer | undefined;
  // Raced rather than awaited after a kill: a grandchild could hold the pipes open long after orca dies.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${what}: no answer within ${timeoutMs}ms`));
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
      throw new Error(`${what}: exit ${code}, unparsable output: ${stderr.trim().slice(0, 300)}`);
    }
    if (!isRecord(out) || out.ok !== true || !isRecord(out.result)) {
      throw new Error(`${what} failed: ${JSON.stringify(isRecord(out) ? out.error : out).slice(0, 300)}`);
    }
    return out.result;
  } finally {
    clearTimeout(timer);
  }
}
