import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchConfig } from "../src/dispatch/config";

export const FIXTURES = join(import.meta.dir, "fixtures");
export const fixture = (name: string) => join(FIXTURES, name);

/**
 * A fake `claude`/`codex`. The env is stripped, so it takes its instruction from the prompt (the last argv).
 * Modes write pids to files so tests can check the processes they leave behind.
 */
const FAKE_CLI = `#!/bin/sh
for last; do :; done
arg="\${last#*:}"
case "$last" in
  replay:*) cat "$arg" ;;
  dump:*) printf '%s\\n' "$@" > "$arg/argv"; printf '%s\\0' "$@" > "$arg/argv0"; env > "$arg/env"; cat "${fixture("claude-headless.stream.jsonl")}" ;;
  started:*) : > "$arg"; cat "${fixture("claude-headless.stream.jsonl")}" ;;
  hang:*)
    echo '{"type":"system","subtype":"init","session_id":"s","model":"m"}'
    sleep 300 &
    echo $! > "$arg"
    wait ;;
  late:*)
    trap 'sleep 301 & echo $! > "$arg"; exit 0' TERM
    sleep 300 &
    wait ;;
  detach:*)
    # A real detached child: setsid in a forked child, then fork again so it is reparented to launchd in a group
    # and session of its own, with its cwd still the worktree; the CLI exits once the pid is written.
    /usr/bin/perl -MPOSIX -e 'exit 0 if fork; POSIX::setsid(); exit 0 if fork; open(my $f, ">", $ARGV[0]); print $f $$; close $f; exec "/bin/sleep", "304"' "$arg"
    while [ ! -s "$arg" ]; do sleep 0.05; done
    cat "${fixture("claude-headless.stream.jsonl")}" ;;
  orphan:*)
    (sleep 302 & echo $! > "$arg")
    sleep 300 &
    wait ;;
esac
`;

/**
 * A fake `orca`. It gets a minimal env, so its behavior comes from the `orca-mode` file next to it:
 * ok, fail (`ok: false`), hang (every call), hang-create (only `terminal create`), or ok-exit (an ok envelope, exit 3).
 * `terminal list` prints the `orca-list` file when there is one. Every call's argv is appended to `orca-calls`,
 * one argument per line, then `--`.
 */
const fakeOrca = (bin: string) => `#!/bin/sh
printf '%s\\n' "$@" -- >> "${bin}/orca-calls"
mode=$(cat "${bin}/orca-mode" 2>/dev/null || echo ok)
case "$mode" in
  fail) echo '{"ok":false,"error":{"code":"runtime_unavailable"}}'; exit 1 ;;
  hang) sleep 30 ;; # a grandchild that holds the pipes after orca is killed
  hang-create) [ "$1 $2" = "terminal create" ] && sleep 30 ;;
esac
case "$1 $2" in
  "terminal create") echo '{"ok":true,"result":{"terminal":{"handle":"term_fake"}}}' ;;
  "terminal list") cat "${bin}/orca-list" 2>/dev/null || echo '{"ok":true,"result":{"terminals":[]}}' ;;
  *) echo '{"ok":true,"result":{}}' ;;
esac
[ "$mode" = ok-exit ] && exit 3
exit 0
`;

export interface Sandbox {
  /** Temp dir standing in for the worktree. */
  worktree: string;
  /** Under the repo, because the state root must be outside every agent-writable temp root. */
  stateRoot: string;
  logDir: string;
  /** Holds the fakes; `orca-mode` and `orca-calls` live here. */
  bin: string;
  /** The account home in the config: HOME seen by the fake agent, and where `~` deny entries point. Outside the state root. */
  home: string;
  /** The fake Codex home, which holds the fixture Codex sessions. */
  codexHome: string;
  config: DispatchConfig;
  cleanup: () => void;
}

export function makeSandbox(): Sandbox {
  const worktree = mkdtempSync(join(tmpdir(), "dispatch-wt-"));
  const bin = join(worktree, "..", `${worktree.split("/").pop()}-bin`);
  mkdirSync(bin);
  writeFileSync(join(bin, "fake-cli"), FAKE_CLI);
  chmodSync(join(bin, "fake-cli"), 0o755);
  writeFileSync(join(bin, "fake-orca"), fakeOrca(bin));
  chmodSync(join(bin, "fake-orca"), 0o755);
  mkdirSync(join(import.meta.dir, ".state"), { recursive: true });
  const stateRoot = mkdtempSync(join(import.meta.dir, ".state", "run-"));
  const logDir = join(stateRoot, "logs");
  mkdirSync(logDir);
  const home = mkdtempSync(join(import.meta.dir, ".state", "home-"));
  const harnessHomes = { claude: join(stateRoot, "claude-home"), codex: join(stateRoot, "codex-home") };
  for (const dir of Object.values(harnessHomes)) mkdirSync(dir, { mode: 0o700 });
  const config: DispatchConfig = {
    // Fake executables come in explicitly here, never through PATH.
    executables: { claude: join(bin, "fake-cli"), codex: join(bin, "fake-cli"), orca: join(bin, "fake-orca"), ps: "/bin/ps", git: "/usr/bin/git", lsof: "/usr/sbin/lsof" },
    accountHome: home,
    stateRoot,
    harnessHomes,
    agentPath: "/usr/bin:/bin",
    managedSettingsPaths: [join(stateRoot, "managed-settings.json"), join(stateRoot, "managed-settings.d")],
  };
  return {
    worktree,
    bin,
    stateRoot,
    logDir,
    home,
    codexHome: harnessHomes.codex,
    config,
    cleanup: () => {
      rmSync(worktree, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A killed orphan stays a zombie until launchd reaps it, so poll briefly. */
export async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(20);
  return !alive(pid);
}

export async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 500; i++) {
    const f = Bun.file(file);
    if (await f.exists()) {
      const text = (await f.text()).trim();
      if (text) return Number(text);
    }
    await Bun.sleep(10);
  }
  throw new Error(`no pid in ${file}`);
}

export function writeLines(dir: string, name: string, lines: string[], trailingNewline = true): string {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n") + (trailingNewline ? "\n" : ""));
  return path;
}
