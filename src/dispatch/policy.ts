/**
 * Credential stores no agent may read.
 * Entries are `~/`-relative or absolute; both harnesses expand `~` themselves.
 */
export const DEFAULT_DENY_READ: readonly string[] = [
  "~/.software-factory",
  "~/.factory", // another tool's state dir on this machine
  "~/.ssh",
  "~/.config/gh",
  "~/Library/Keychains",
  "~/.codex/auth.json",
  "~/.claude/.credentials.json",
  "~/.aws",
  "~/.config/gcloud",
  "~/.docker/config.json",
  "~/.gnupg",
  "~/.netrc",
  "~/.npmrc",
  "~/.git-credentials",
];

/**
 * The only parent variables an agent process inherits.
 * Everything else, including tokens, `CLAUDE_CODE_*`, and `ORCA_*`, is dropped.
 */
const ENV_ALLOWLIST = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "TERM"] as const;

export function agentEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  if (!env.HOME) throw new Error("agentEnv: HOME is required for CLI auth");
  return env;
}

export function assertDenyPath(path: string): void {
  if (!(path.startsWith("~/") || path.startsWith("/"))) {
    throw new Error(`deny-read path must be absolute or ~/-relative: ${path}`);
  }
}
