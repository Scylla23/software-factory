import { str, isRecord } from "../dispatch/jsonl";
import { ORCA_TIMEOUT_MS, orcaJson } from "./cli";

export interface MonitorInput {
  /** Trusted `orca` executable from DispatchConfig. */
  orcaPath: string;
  worktreePath: string;
  title: string;
  /** The run's stdout log, under the state root. */
  logPath: string;
  timeoutMs?: number;
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
  const timeoutMs = input.timeoutMs ?? ORCA_TIMEOUT_MS;
  const command = monitorCommand(input.title, input.logPath); // throws on a bad title, before anything starts
  const problems: string[] = [];
  const opened: Promise<string | null> = (async () => {
    const result = await orcaJson(
      input.orcaPath,
      ["terminal", "create", "--worktree", `path:${input.worktreePath}`, "--title", input.title, "--command", command],
      timeoutMs,
    );
    const handle = isRecord(result.terminal) ? str(result.terminal.handle) : null;
    if (!handle) throw new Error(`orca terminal create returned no handle: ${JSON.stringify(result).slice(0, 300)}`);
    return handle;
  })().catch((err) => {
    problems.push(`open failed: ${(err as Error).message}`);
    return null;
  });
  return {
    close: async () => {
      const handle = await opened;
      if (handle) {
        try {
          await orcaJson(input.orcaPath, ["terminal", "close", "--terminal", handle], timeoutMs);
        } catch (err) {
          problems.push(`close failed for ${handle}: ${(err as Error).message}`);
        }
      }
      return problems;
    },
  };
}
