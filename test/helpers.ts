import { chmodSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchConfig } from "../src/dispatch/config";

export const FIXTURES = join(import.meta.dir, "fixtures");

/** Identify regular-file descriptors even when a failed reservation has unlinked the file. */
export function openFileDescriptors(): Set<string> {
  const files = new Set<string>();
  for (const fd of readdirSync("/dev/fd")) {
    try {
      const file = fstatSync(Number(fd), { bigint: true });
      if (file.isFile()) files.add(`${fd}:${file.dev}:${file.ino}`);
    } catch (error) {
      // Reading /dev/fd may list the directory descriptor that readdirSync itself just closed.
      if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
    }
  }
  return files;
}

/**
 * Where tests keep state that must be outside the temp roots: `test/.state`, or the run's own directory when the
 * watchdog (scripts/test-watchdog.sh) sets FACTORY_TEST_STATE, so it can find exactly what its run left behind.
 */
export const STATE_DIR = process.env.FACTORY_TEST_STATE || join(import.meta.dir, ".state");
if (!STATE_DIR.startsWith("/")) throw new Error(`FACTORY_TEST_STATE must be absolute: ${STATE_DIR}`);
mkdirSync(STATE_DIR, { recursive: true });
export const fixture = (name: string) => join(FIXTURES, name);

/**
 * A fake `claude`/`codex`. The env is stripped, so it takes its instruction from the prompt (the last argv).
 * Modes write pids to files so tests can check the processes they leave behind.
 */
const FAKE_CLI = `#!/bin/sh
for last; do :; done
arg="\${last#*:}"
session=""
previous=""
for word; do
  if [ "$previous" = "--session-id" ]; then session="$word"; fi
  previous="$word"
done
if [ -n "$session" ]; then
  mkdir -p "$CLAUDE_CONFIG_DIR/projects/test"
  echo '{"type":"api-request-shape","shape":{"system":[{"type":"text","text":"Test instructions"}]}}' > "$CLAUDE_CONFIG_DIR/projects/test/$session.jsonl"
fi
replay() {
  if [ -n "$session" ]; then sed "s/04fdfd03-327c-4f04-8a7c-b1d5df6a3357/$session/g" "$1"; else cat "$1"; fi
}
case "$last" in
  home-change:*) : > "$CLAUDE_CONFIG_DIR/CLAUDE.md"; replay "${fixture("claude-headless.stream.jsonl")}" ;;
  replay:*) replay "$arg" ;;
  dump:*) printf '%s\\n' "$@" > "$arg/argv"; printf '%s\\0' "$@" > "$arg/argv0"; env > "$arg/env"; replay "${fixture("claude-headless.stream.jsonl")}" ;;
  started:*) : > "$arg"; replay "${fixture("claude-headless.stream.jsonl")}" ;;
  hang:*)
    head -n 1 "${fixture("claude-headless.stream.jsonl")}" | sed "s/04fdfd03-327c-4f04-8a7c-b1d5df6a3357/$session/g"
    sleep 300 &
    echo $! > "$arg"
    wait ;;
  late:*)
    trap 'sleep 301 & echo $! > "$arg"; exit 0' TERM
    echo $$ > "$arg.ready"
    # A signal to the current sleep can return wait before the shell itself receives TERM.
    while :; do sleep 300 & wait; done ;;
  detach:*)
    # A real detached child: setsid in a forked child, then fork again so it is reparented to launchd in a group
    # and session of its own, with its cwd still the worktree; the CLI exits once the pid is written.
    /usr/bin/perl -MPOSIX -e 'exit 0 if fork; POSIX::setsid(); exit 0 if fork; open(my $f, ">", $ARGV[0]); print $f $$; close $f; exec "/bin/sleep", "304"' "$arg"
    while [ ! -s "$arg" ]; do sleep 0.05; done
    replay "${fixture("claude-headless.stream.jsonl")}" ;;
  orphan:*)
    (sleep 302 & echo $! > "$arg")
    sleep 300 &
    wait ;;
esac
`;

/**
 * A fake `orca`. It gets a minimal env, so its behavior comes from the `orca-mode` file next to it:
 * ok, fail (`ok: false`), hang (every call), hang-create (only `terminal create`), or ok-exit (an ok envelope, exit 3).
 * `terminal list` prints the `orca-list` file when there is one; an `orca-delay` file makes every call except
 * `terminal create` wait that many seconds first, like a busy runtime. Every call's argv is appended to `orca-calls`,
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
delay=$(cat "${bin}/orca-delay" 2>/dev/null)
[ -n "$delay" ] && [ "$1 $2" != "terminal create" ] && sleep "$delay"
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
  const stateRoot = mkdtempSync(join(STATE_DIR, "run-"));
  const logDir = join(stateRoot, "logs");
  mkdirSync(logDir);
  const home = mkdtempSync(join(STATE_DIR, "home-"));
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
