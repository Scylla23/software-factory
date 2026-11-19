import { closeSync, constants, lstatSync, openSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { overlaps, SYSTEM_PATH_DIRS } from "./policy";
import type { Harness } from "./types";

/**
 * Everything dispatch trusts, resolved once at factory startup from factory-controlled sources,
 * never from the inherited PATH or an agent-writable directory.
 */
export interface DispatchConfig {
  /** Absolute, canonical paths. */
  executables: Record<Harness | "ps" | "orca" | "git" | "lsof", string>;
  /** Canonical account home from the user database (getpwuid), never $HOME; owner-protection paths derive from it. */
  accountHome: string;
  /** Canonical factory state dir; run logs must live under it. */
  stateRoot: string;
  /**
   * Each harness's dedicated home (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`), private dirs under the state root that the owner
   * logged in to once, so no owner instructions, hooks, skills, plugins, or config reach factory runs.
   */
  harnessHomes: Record<Harness, string>;
  /** The agent's whole PATH: the verified harness bin dirs, then the system dirs. Never derived from the inherited PATH. */
  agentPath: string;
  /** Claude managed-settings locations; a Claude dispatch is refused while any of them exists. */
  managedSettingsPaths: readonly string[];
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
}

export function loadDispatchConfig(opts: LoadOptions): DispatchConfig {
  const untrusted = [...tempRoots(), ...opts.agentWriteRoots.map(canonical)];
  const harnessBinDirs: string[] = [];
  const find = (name: string, isHarness = false) => {
    for (const dir of TRUSTED_BIN_DIRS) {
      const candidate = join(dir, name);
      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        continue;
      }
      const exe = assertTrustedExecutable(real, untrusted);
      if (isHarness) harnessBinDirs.push(dir, dirname(exe));
      return exe;
    }
    throw new Error(`${name} not found in ${TRUSTED_BIN_DIRS.join(", ")}`);
  };
  const accountHome = canonical(HOME);
  const stateRoot = canonical(opts.stateRoot ?? join(accountHome, ".software-factory"));
  assertStateRootIsolated(stateRoot, untrusted);
  assertSafeDir(stateRoot, accountHome);
  const homes = { claude: join(stateRoot, "claude-home"), codex: join(stateRoot, "codex-home") };
  for (const home of Object.values(homes)) assertPrivateDir(home, stateRoot);
  return {
    executables: { claude: find("claude", true), codex: find("codex", true), orca: find("orca"), ps: assertTrustedExecutable("/bin/ps", untrusted), git: assertTrustedExecutable("/usr/bin/git", untrusted), lsof: assertTrustedExecutable("/usr/sbin/lsof", untrusted) },
    accountHome,
    stateRoot,
    harnessHomes: homes,
    agentPath: trustedAgentPath(harnessBinDirs, untrusted),
    managedSettingsPaths: CLAUDE_MANAGED_SETTINGS_PATHS,
  };
}

/**
 * The harness bin dirs, each canonical, outside every untrusted root, owned by root or the user, and not group or
 * world writable (a writable PATH dir lets anyone plant a command), then the system dirs; deduplicated.
 */
export function trustedAgentPath(harnessBinDirs: readonly string[], untrustedRoots: readonly string[]): string {
  const dirs: string[] = [];
  for (const dir of harnessBinDirs) {
    const real = realpathSync(dir);
    for (const root of untrustedRoots) if (isUnder(real, root)) throw new Error(`PATH dir ${real} is under agent-writable ${root}`);
    const st = statSync(real);
    if (!st.isDirectory()) throw new Error(`PATH entry is not a directory: ${real}`);
    if ((st.mode & 0o022) !== 0) throw new Error(`PATH dir is group or world writable: ${real}`);
    if (st.uid !== 0 && st.uid !== process.getuid!()) throw new Error(`PATH dir owned by uid ${st.uid}: ${real}`);
    dirs.push(real);
  }
  return [...new Set([...dirs, ...SYSTEM_PATH_DIRS])].join(":");
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

/** Refuses a state root that contains, or is contained by, any agent write root or readable carve-out. */
export function assertStateRootIsolated(stateRoot: string, roots: readonly string[]): void {
  for (const root of roots) if (overlaps(stateRoot, root)) throw new Error(`state root ${stateRoot} overlaps agent-reachable ${root}`);
}

/**
 * A directory owned by the user, where neither it nor any parent up to `home` (or up to `/` outside the home) is
 * group or world writable, so nobody else can swap a component of the path.
 */
export function assertSafeDir(path: string, home: string): void {
  const st = statSync(path);
  if (!st.isDirectory()) throw new Error(`not a directory: ${path}`);
  if (st.uid !== process.getuid!()) throw new Error(`${path} is owned by uid ${st.uid}`);
  const stop = isUnder(path, home) ? home : "/";
  for (let dir = path; ; dir = dirname(dir)) {
    const mode = statSync(dir).mode;
    if ((mode & 0o022) !== 0) throw new Error(`${dir} is group or world writable (mode ${(mode & 0o777).toString(8)}), so ${path} is not safe`);
    if (dir === stop || dir === "/") break;
  }
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
 * Any source that exists, whatever it holds (even an empty file or directory), refuses Claude dispatch;
 * a location that cannot be checked counts as existing. There is deliberately no way to accept one.
 */
export function managedSettingsProblems(config: DispatchConfig): string[] {
  const problems: string[] = [];
  for (const path of config.managedSettingsPaths) {
    try {
      lstatSync(path);
      problems.push(`${path}: exists`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${path}: cannot check (${(err as Error).message})`);
    }
  }
  return problems;
}

export interface RunFiles {
  stdoutPath: string;
  stderrPath: string;
  /** Where the exact project instructions are kept, when the run has any. */
  instructionsPath: string;
}

export interface RunLogs {
  stdoutPath: string;
  stderrPath: string;
  stdoutFd: number;
  stderrFd: number;
}

/**
 * This attempt's file paths, without creating anything: refuses a log dir outside the state root or inside an agent
 * write root, and an attempt id that already has any file there (a symlink included).
 */
export function planRunFiles(config: DispatchConfig, logDir: string, runId: string, agentWriteRoots: readonly string[]): RunFiles {
  const dir = canonical(logDir);
  if (!isUnder(dir, config.stateRoot)) throw new Error(`log dir ${dir} is not under the state root ${config.stateRoot}`);
  assertSafeDir(dir, config.accountHome);
  for (const root of agentWriteRoots) if (isUnder(dir, root)) throw new Error(`log dir ${dir} is under agent-writable ${root}`);
  const files = {
    stdoutPath: join(dir, `${runId}.stdout.jsonl`),
    stderrPath: join(dir, `${runId}.stderr.log`),
    instructionsPath: join(dir, `${runId}.instructions.md`),
  };
  for (const path of Object.values(files)) {
    try {
      lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    throw new Error(`run ${runId} already has a file at ${path}; attempt ids are single-use`);
  }
  return files;
}

/**
 * Creates the attempt's files exclusively (private, never through a symlink) and writes the instructions, if any.
 * All or nothing: on any failure it closes what it opened and removes what it created, so the attempt id stays unused.
 */
export function reserveRunFiles(files: RunFiles, instructions: string | null): RunLogs {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const created: { path: string; fd: number }[] = [];
  const open = (path: string) => {
    const fd = openSync(path, flags, 0o600);
    created.push({ path, fd });
    return fd;
  };
  try {
    const stdoutFd = open(files.stdoutPath);
    const stderrFd = open(files.stderrPath);
    if (instructions !== null) {
      const fd = open(files.instructionsPath);
      writeSync(fd, instructions);
      closeSync(fd);
      created.pop();
      created.push({ path: files.instructionsPath, fd: -1 });
    }
    return { stdoutPath: files.stdoutPath, stderrPath: files.stderrPath, stdoutFd, stderrFd };
  } catch (err) {
    for (const { path, fd } of created) {
      if (fd >= 0) closeSync(fd);
      unlinkSync(path);
    }
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`attempt files already exist; attempt ids are single-use: ${(err as Error).message}`);
    throw err;
  }
}
