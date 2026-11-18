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
const ENV_ALLOWLIST = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "TERM"] as const;

/** The variable that points each harness at its dedicated home. */
export const HARNESS_HOME_VAR = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" } as const;

/**
 * The agent's environment: the allowlisted parent variables plus the harness home, which always comes from the
 * factory's config and never from the parent.
 */
export function agentEnv(parent: Record<string, string | undefined>, harness: keyof typeof HARNESS_HOME_VAR, harnessHome: string): Record<string, string> {
  if (!harnessHome.startsWith("/")) throw new Error(`agentEnv: harness home must be absolute: ${harnessHome}`);
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  if (!env.HOME) throw new Error("agentEnv: HOME is required for CLI auth");
  // A relative or empty PATH entry resolves against the agent's cwd, the agent-writable worktree.
  if (env.PATH !== undefined) env.PATH = env.PATH.split(":").filter((d) => d.startsWith("/")).join(":");
  env[HARNESS_HOME_VAR[harness]] = harnessHome;
  return env;
}
