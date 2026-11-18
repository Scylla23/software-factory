/**
 * Paths no agent may read, applied to every run of both harnesses.
 * Entries are `~/`-relative or absolute, and may use `*` globs; both harnesses expand `~` themselves.
 */
export const MANDATORY_DENY_READ: readonly string[] = [
  // Factory state, including the harness homes with their auth and the factory's own transcripts.
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
  // Factory runs use dedicated homes, so neither CLI needs these; Codex gets ~/.codex/packages back (codex.ts).
  "~/.claude",
  "~/.claude.json",
  "~/.codex",
  "~/.agents", // the owner's cross-harness skills
  "~/Library/Application Support/orca",
];

/** The mandatory deny-list plus per-run additions; additions can only widen it. */
export function effectiveDenyRead(extra: readonly string[] = []): string[] {
  const all = [...MANDATORY_DENY_READ, ...extra];
  for (const p of all) assertDenyPath(p);
  return [...new Set(all)];
}

function assertDenyPath(path: string): void {
  if (!(path.startsWith("~/") || path.startsWith("/"))) {
    throw new Error(`deny-read path must be absolute or ~/-relative: ${path}`);
  }
}

/**
 * The only parent variables an agent process inherits.
 * Everything else, including tokens, `CLAUDE_CODE_*`, and `ORCA_*`, is dropped.
 */
const ENV_ALLOWLIST = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM"] as const;

/** System dirs every agent PATH starts from, and the whole PATH when nothing else is configured. */
export const SYSTEM_PATH_DIRS: readonly string[] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** The variable that points each harness at its dedicated home. */
export const HARNESS_HOME_VAR = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" } as const;

/**
 * The agent's environment: the allowlisted parent variables, plus PATH and the harness home, which always come from
 * the factory's config and never from the parent. `trustedPath` is DispatchConfig.agentPath; an empty one falls back
 * to the system dirs.
 */
export function agentEnv(
  parent: Record<string, string | undefined>,
  harness: keyof typeof HARNESS_HOME_VAR,
  harnessHome: string,
  trustedPath: string,
): Record<string, string> {
  if (!harnessHome.startsWith("/")) throw new Error(`agentEnv: harness home must be absolute: ${harnessHome}`);
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  if (!env.HOME) throw new Error("agentEnv: HOME is required for CLI auth");
  const dirs = trustedPath.split(":").filter(Boolean);
  if (dirs.some((d) => !d.startsWith("/"))) throw new Error(`agentEnv: trusted PATH has a relative entry: ${trustedPath}`);
  env.PATH = (dirs.length > 0 ? dirs : SYSTEM_PATH_DIRS).join(":");
  env[HARNESS_HOME_VAR[harness]] = harnessHome;
  return env;
}
