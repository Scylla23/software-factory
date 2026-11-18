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

/**
 * `--title` only sets the pane title; the tab's live title follows the shell, which the owner's zsh sets to the running
 * command, so the command also sets it with an OSC 0 escape.
 */
export function monitorCommand(title: string, logPath: string): string {
  return `printf '\\033]0;%s\\007' ${shellQuote(title)}; tail -n +1 -f ${shellQuote(logPath)}`;
}

/**
 * Opens a read-only Orca terminal in the run's worktree that tails the run log.
 * Best effort: it starts in the background, and no failure reaches the run.
 */
export function openRunMonitor(input: MonitorInput): RunMonitor {
  const timeoutMs = input.timeoutMs ?? ORCA_TIMEOUT_MS;
  const problems: string[] = [];
  const opened: Promise<string | null> = (async () => {
    const result = await orcaJson(
      input.orcaPath,
      ["terminal", "create", "--worktree", `path:${input.worktreePath}`, "--title", input.title, "--command", monitorCommand(input.title, input.logPath)],
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
