import { realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * Paths no agent may read, applied to every run of both harnesses.
 * Entries are `~/`-relative or absolute, and may use `*` globs. `~` is expanded by the factory to the account home
 * from the user database, never by the harnesses from an inherited HOME.
 */
export const MANDATORY_DENY_READ: readonly string[] = [
  // Factory state at its default location; the configured state root and harness homes are added by realpath.
  "~/.software-factory",
  "~/.factory", // another tool's state dir on this machine
  // Credential stores.
  "~/.ssh",
  "~/.config/gh",
  "~/Library/Keychains",
  "~/.aws",
  "~/.config/gcloud",
  "~/.docker/config.json",
  "~/.gnupg",
  "~/.netrc",
  "~/.npmrc",
  "~/.git-credentials",
  // The owner's own harness homes: auth, history of other projects, instructions, settings, skills, plugins.
  // Factory runs use dedicated homes, so neither CLI needs these; Codex gets its own binary's dir back (codexReadable).
  "~/.claude",
  "~/.claude.json",
  "~/.codex",
  "~/.agents", // the owner's cross-harness skills
  "~/Library/Application Support/orca",
];

/** What the deny-list is computed from, all canonical. */
export interface PolicyContext {
  /** The account home from the user database (getpwuid), never $HOME. */
  accountHome: string;
  stateRoot: string;
  harnessHomes: readonly string[];
}

/** The read policy both harnesses enforce: absolute deny paths, and the narrower paths Codex may still read. */
export interface SandboxPolicy {
  denyRead: readonly string[];
  /** Read access carved back out of a denied tree; Codex only. */
  readable: readonly string[];
  /** Absolute paths agents may read but never write: the run's git dirs (see `gitWriteProtectedPaths`). */
  denyWrite: readonly string[];
}

export function expandHome(path: string, home: string): string {
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/**
 * The mandatory deny-list plus per-run additions, as absolute paths under the account home, each also by its
 * realpath when that differs (a symlinked ~/.ssh), plus the configured state root and harness homes by realpath.
 * Additions can only widen it.
 */
export function effectiveDenyRead(ctx: PolicyContext, extra: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const p of [...MANDATORY_DENY_READ, ...extra]) {
    assertDenyPath(p);
    const abs = expandHome(p, ctx.accountHome);
    out.push(abs);
    const real = abs.includes("*") ? null : realpathOrNull(abs);
    if (real && real !== abs) out.push(real);
  }
  for (const p of [ctx.stateRoot, ...ctx.harnessHomes]) out.push(p, realpathSync(p));
  return [...new Set(out)];
}

/**
 * Refuses a policy whose readable carve-outs would reopen the state root or a harness home,
 * and a carve-out that is itself a deny entry (a duplicate TOML key, and an ambiguous intent).
 */
export function assertPolicySound(policy: SandboxPolicy, ctx: PolicyContext): void {
  for (const r of policy.readable) {
    if (policy.denyRead.includes(r)) throw new Error(`cannot deny ${r}: Codex needs it readable to run`);
    for (const p of [ctx.stateRoot, ...ctx.harnessHomes]) {
      if (overlaps(r, p)) throw new Error(`readable carve-out ${r} overlaps factory state ${p}`);
    }
  }
}

/** Refuses a write-deny that would cover the worktree itself: its working files must stay writable. */
export function assertWorktreeWritable(policy: SandboxPolicy, worktree: string): void {
  for (const d of policy.denyWrite) {
    if (worktree === d || worktree.startsWith(`${d}/`)) throw new Error(`write-deny ${d} would cover the worktree ${worktree}`);
  }
}

/** One path contains the other. */
export function overlaps(a: string, b: string): boolean {
  const under = (x: string, y: string) => x === y || x.startsWith(`${y.endsWith("/") ? y.slice(0, -1) : y}/`);
  return under(a, b) || under(b, a);
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function assertDenyPath(path: string): void {
  if (!(path.startsWith("~/") || path.startsWith("/"))) {
    throw new Error(`deny-read path must be absolute or ~/-relative: ${path}`);
  }
}

/**
 * The only parent variables an agent process inherits; HOME and PATH are set from the config instead.
 * Everything else, including tokens, `CLAUDE_CODE_*`, and `ORCA_*`, is dropped.
 */
const ENV_ALLOWLIST = ["USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM"] as const;

/** System dirs every agent PATH starts from, and the whole PATH when nothing else is configured. */
export const SYSTEM_PATH_DIRS: readonly string[] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** The variable that points each harness at its dedicated home. */
export const HARNESS_HOME_VAR = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" } as const;

export interface AgentEnvInput {
  harness: keyof typeof HARNESS_HOME_VAR;
  harnessHome: string;
  /** DispatchConfig.agentPath; an empty one falls back to the system dirs. */
  trustedPath: string;
  /** The account home from the user database, which replaces any inherited HOME. */
  accountHome: string;
}

/**
 * The agent's environment: the allowlisted parent variables, plus HOME, PATH, and the harness home, which always come
 * from the factory's config and never from the parent.
 */
export function agentEnv(parent: Record<string, string | undefined>, input: AgentEnvInput): Record<string, string> {
  for (const [name, p] of [["harness home", input.harnessHome], ["account home", input.accountHome]] as const) {
    if (!p.startsWith("/")) throw new Error(`agentEnv: ${name} must be absolute: ${p}`);
  }
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  env.HOME = input.accountHome;
  const dirs = input.trustedPath.split(":").filter(Boolean);
  if (dirs.some((d) => !d.startsWith("/"))) throw new Error(`agentEnv: trusted PATH has a relative entry: ${input.trustedPath}`);
  env.PATH = (dirs.length > 0 ? dirs : SYSTEM_PATH_DIRS).join(":");
  env[HARNESS_HOME_VAR[input.harness]] = input.harnessHome;
  return env;
}
