import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Harness } from "./types";

/**
 * Everything dispatch trusts, resolved once at factory startup from factory-controlled sources,
 * never from the inherited PATH or an agent-writable directory.
 */
export interface DispatchConfig {
  /** Absolute, canonical paths. */
  executables: Record<Harness | "ps" | "orca", string>;
  /** Canonical factory state dir; run logs must live under it. */
  stateRoot: string;
  /**
   * Each harness's dedicated home (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`), private dirs under the state root that the owner
   * logged in to once, so no owner instructions, hooks, skills, plugins, or config reach factory runs.
   */
  harnessHomes: Record<Harness, string>;
  /** Claude managed-settings locations checked before every Claude dispatch. */
  managedSettingsPaths: readonly string[];
  /** Managed-settings files the owner accepted, as canonical path to sha256 of contents. */
  acceptedManagedSettings: Readonly<Record<string, string>>;
}

const HOME = userInfo().homedir; // from the user database, not $HOME

/** Install locations the factory trusts, in order; deliberately not $PATH. */
export const TRUSTED_BIN_DIRS: readonly string[] = [join(HOME, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];

/** Where Claude Code reads managed (policy) settings on macOS; any of them can widen the policy under --restricted. */
export const CLAUDE_MANAGED_SETTINGS_PATHS: readonly string[] = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/Library/Application Support/ClaudeCode/managed-settings.d",
  "/Library/Managed Preferences/com.anthropic.claudecode.plist",
  `/Library/Managed Preferences/${userInfo().username}/com.anthropic.claudecode.plist`,
];

/** Directories every agent can write: the system temp roots (worktrees are added per run). */
export function tempRoots(): string[] {
  const roots = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
  try {
    roots.push(realpathSync(tmpdir()));
  } catch {
    // tmpdir() always exists on macOS; nothing to add if it does not
  }
  return [...new Set(roots)];
}

export function isUnder(path: string, root: string): boolean {
  const r = root.endsWith("/") ? root.slice(0, -1) : root;
  return path === r || path.startsWith(`${r}/`);
}

export interface LoadOptions {
  /** Directories agents can write besides the temp roots, such as the Orca workspaces dir. */
  agentWriteRoots: readonly string[];
  stateRoot?: string;
  acceptedManagedSettings?: Readonly<Record<string, string>>;
}

export function loadDispatchConfig(opts: LoadOptions): DispatchConfig {
  const untrusted = [...tempRoots(), ...opts.agentWriteRoots.map(canonical)];
  const find = (name: string) => {
    for (const dir of TRUSTED_BIN_DIRS) {
      const candidate = join(dir, name);
      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        continue;
      }
      return assertTrustedExecutable(real, untrusted);
    }
    throw new Error(`${name} not found in ${TRUSTED_BIN_DIRS.join(", ")}`);
  };
  const stateRoot = canonical(opts.stateRoot ?? join(HOME, ".software-factory"));
  for (const root of untrusted) if (isUnder(stateRoot, root)) throw new Error(`state root ${stateRoot} is under agent-writable ${root}`);
  const homes = { claude: join(stateRoot, "claude-home"), codex: join(stateRoot, "codex-home") };
  for (const home of Object.values(homes)) assertPrivateDir(home, stateRoot);
  return {
    executables: { claude: find("claude"), codex: find("codex"), orca: find("orca"), ps: assertTrustedExecutable("/bin/ps", untrusted) },
    stateRoot,
    harnessHomes: homes,
    managedSettingsPaths: CLAUDE_MANAGED_SETTINGS_PATHS,
    acceptedManagedSettings: opts.acceptedManagedSettings ?? {},
  };
}

/** A regular executable, owned by the user or root, not group/world writable, outside every untrusted root. */
export function assertTrustedExecutable(path: string, untrustedRoots: readonly string[]): string {
  const real = realpathSync(path);
  for (const root of untrustedRoots) if (isUnder(real, root)) throw new Error(`executable ${real} is under agent-writable ${root}`);
  const st = statSync(real);
  if (!st.isFile() || (st.mode & 0o111) === 0) throw new Error(`not an executable file: ${real}`);
  if ((st.mode & 0o022) !== 0) throw new Error(`executable is group or world writable: ${real}`);
  if (st.uid !== 0 && st.uid !== process.getuid!()) throw new Error(`executable owned by uid ${st.uid}: ${real}`);
  return real;
}

/** An existing directory, canonical at `path`, under `root`, owned by the user, with no group or world access. */
export function assertPrivateDir(path: string, root: string): string {
  const st = lstatSync(path);
  if (!st.isDirectory()) throw new Error(`not a directory (or a symlink): ${path}`);
  const real = realpathSync(path);
  if (real !== path) throw new Error(`${path} is not canonical (resolves to ${real})`);
  if (!isUnder(real, root)) throw new Error(`${real} is not under ${root}`);
  if (st.uid !== process.getuid!()) throw new Error(`${real} is owned by uid ${st.uid}`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${real} is accessible to group or others (mode ${(st.mode & 0o777).toString(8)})`);
  return real;
}

function canonical(path: string): string {
  return realpathSync(path);
}

/**
 * Managed settings take precedence over --settings and survive --restricted, so they can widen egress or reads.
 * Returns one problem per present and unaccepted file; an unreadable location counts as present.
 */
export function managedSettingsProblems(config: DispatchConfig): string[] {
  const problems: string[] = [];
  const check = (file: string) => {
    let digest: string;
    try {
      digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    } catch (err) {
      problems.push(`${file}: unreadable (${(err as Error).message})`);
      return;
    }
    const accepted = config.acceptedManagedSettings[file];
    if (accepted !== digest) problems.push(`${file}: present and not accepted (sha256 ${digest})`);
  };
  for (const path of config.managedSettingsPaths) {
    let st;
    try {
      st = lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      problems.push(`${path}: cannot stat (${(err as Error).message})`);
      continue;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(path).sort()) check(join(path, name));
    } else {
      check(path);
    }
  }
  return problems;
}

export interface RunLogs {
  stdoutPath: string;
  stderrPath: string;
  stdoutFd: number;
  stderrFd: number;
}

/**
 * Creates this attempt's log files, refusing a log dir outside the state root or inside an agent write root,
 * an attempt id that already has logs, and a symlink at the log path.
 */
export function createRunLogs(config: DispatchConfig, logDir: string, runId: string, agentWriteRoots: readonly string[]): RunLogs {
  const dir = canonical(logDir);
  if (!isUnder(dir, config.stateRoot)) throw new Error(`log dir ${dir} is not under the state root ${config.stateRoot}`);
  for (const root of agentWriteRoots) if (isUnder(dir, root)) throw new Error(`log dir ${dir} is under agent-writable ${root}`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const open = (path: string) => {
    try {
      return openSync(path, flags, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`run ${runId} already has a log at ${path}; attempt ids are single-use`);
      throw err;
    }
  };
  const stdoutPath = join(dir, `${runId}.stdout.jsonl`);
  const stderrPath = join(dir, `${runId}.stderr.log`);
  const stdoutFd = open(stdoutPath);
  let stderrFd: number;
  try {
    stderrFd = open(stderrPath);
  } catch (err) {
    closeSync(stdoutFd);
    throw err;
  }
  return { stdoutPath, stderrPath, stdoutFd, stderrFd };
}

/** Writes a new private file next to the logs; like the logs, it refuses to replace anything. */
export function writeRunFile(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}
