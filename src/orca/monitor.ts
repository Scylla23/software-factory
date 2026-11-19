import { str, isRecord } from "../dispatch/jsonl";
import { ORCA_TIMEOUT_MS, OrcaError, orcaJson } from "./cli";

export interface MonitorInput {
  /** Trusted `orca` executable from DispatchConfig. */
  orcaPath: string;
  worktreePath: string;
  /** Contains `attemptId`, which identifies the tab when a failed create must be reconciled. */
  title: string;
  attemptId: string;
  /** The run's stdout log, under the state root. */
  logPath: string;
  /** Bound on the create call. */
  openTimeoutMs?: number;
  /**
   * Bound on each close and reconcile call, separate from the create's: a create that timed out on a busy runtime
   * must not leave the cleanup that follows it less time.
   */
  cleanupTimeoutMs?: number;
}

export interface RunMonitor {
  /** Closes the tab once it is open; resolves with what went wrong, never rejects. */
  close: () => Promise<string[]>;
}

/** POSIX single-quoting: the command is typed into the owner's interactive login shell. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Plain words joined by single spaces, such as `factory: builder <runId>`; nothing a terminal or shell interprets. */
const MONITOR_TITLE = /^(?=.{1,128}$)[A-Za-z0-9._:-]+(?: [A-Za-z0-9._:-]+)*$/;
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOG_PATH = /^\/[^\x00-\x1f\x7f]*$/;

/** Sets the title, then becomes the trusted tail with no terminal input; `$1` is the title and `$2` the log. */
const VIEWER = `printf '\\033]0;%s\\007' "$1"; exec /usr/bin/tail -n +1 -f -- "$2" </dev/null`;

/**
 * The command typed into the monitor tab's shell. `exec` replaces the owner's interactive shell with a non-interactive
 * `/bin/sh`, which in turn becomes `/usr/bin/tail`, so stopping the viewer (Ctrl-C) ends the tab instead of leaving a
 * prompt in the owner's shell in the run's worktree, and the viewer reads no keystrokes.
 * `--title` only sets the pane title; the tab's live title follows the shell, so the viewer also sets it with OSC 0.
 */
export function monitorCommand(title: string, logPath: string): string {
  if (!MONITOR_TITLE.test(title)) throw new Error(`monitor title must be plain words: ${JSON.stringify(title)}`);
  if (!LOG_PATH.test(logPath)) throw new Error(`monitor log path must be absolute with no control characters: ${JSON.stringify(logPath)}`);
  return `exec /bin/sh -c ${shellQuote(VIEWER)} factory-monitor ${shellQuote(title)} ${shellQuote(logPath)}`;
}

/**
 * Opens a read-only Orca terminal in the run's worktree that tails the run log.
 * Throws only for an invalid title or log path; otherwise best effort: it starts in the background, and no failure
 * reaches the run.
 */
export function openRunMonitor(input: MonitorInput): RunMonitor {
  const openTimeoutMs = input.openTimeoutMs ?? ORCA_TIMEOUT_MS;
  const cleanupTimeoutMs = input.cleanupTimeoutMs ?? ORCA_TIMEOUT_MS;
  const command = monitorCommand(input.title, input.logPath); // throws on a bad title, before anything starts
  if (!ATTEMPT_ID.test(input.attemptId) || !input.title.includes(input.attemptId)) {
    throw new Error(`monitor title ${JSON.stringify(input.title)} must contain the attempt id ${JSON.stringify(input.attemptId)}`);
  }
  const orca = (args: string[], timeoutMs: number) => orcaJson(input.orcaPath, args, timeoutMs);
  const problems: string[] = [];
  let uncertain = false;
  const opened: Promise<string | null> = (async () => {
    const result = await orca(["terminal", "create", "--worktree", `path:${input.worktreePath}`, "--title", input.title, "--command", command], openTimeoutMs);
    const handle = isRecord(result.terminal) ? str(result.terminal.handle) : null;
    if (!handle) throw new OrcaError(`orca terminal create returned no handle: ${JSON.stringify(result).slice(0, 300)}`, true);
    return handle;
  })().catch((err) => {
    uncertain = err instanceof OrcaError && err.uncertain; // a spawn failure ran nothing
    problems.push(`open failed: ${(err as Error).message}`);
    return null;
  });
  const closeTab = async (handle: string) => {
    try {
      await orca(["terminal", "close", "--terminal", handle], cleanupTimeoutMs);
      return true;
    } catch (err) {
      problems.push(`close failed for ${handle}: ${(err as Error).message}`);
      return false;
    }
  };
  /** A create that timed out or answered oddly may still have opened the tab: close every tab titled with this attempt. */
  const reconcile = async () => {
    try {
      const list = await orca(["terminal", "list", "--worktree", `path:${input.worktreePath}`], cleanupTimeoutMs);
      if (!Array.isArray(list.terminals)) throw new Error(`no terminals in ${JSON.stringify(list).slice(0, 300)}`);
      if (list.truncated === true) problems.push("reconcile: terminal list was truncated; a tab may stay open");
      for (const t of list.terminals) {
        if (!isRecord(t) || ![t.title, t.paneTitle].some((v) => typeof v === "string" && v.includes(input.attemptId))) continue;
        const handle = str(t.handle);
        if (!handle) problems.push(`reconcile: a tab for this attempt has no handle`);
        else if (await closeTab(handle)) problems.push(`reconcile: closed ${handle}, opened by the failed create`);
      }
    } catch (err) {
      problems.push(`reconcile failed: ${(err as Error).message}`);
    }
  };
  return {
    close: async () => {
      const handle = await opened;
      if (handle) await closeTab(handle);
      else if (uncertain) await reconcile();
      return problems;
    },
  };
}
