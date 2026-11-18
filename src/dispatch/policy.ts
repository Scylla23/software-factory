/**
 * Paths no agent may read, applied to every run of both harnesses.
 * Entries are `~/`-relative or absolute, and may use `*` globs; both harnesses expand `~` themselves.
 */
export const MANDATORY_DENY_READ: readonly string[] = [
  // Factory state and credential stores.
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
  // The owner's session history and harness state, which hold other projects' conversations.
  // Never all of ~/.codex: Codex re-execs its own binary from ~/.codex/packages inside the sandbox.
  "~/.claude/projects",
  "~/.claude/history.jsonl",
  "~/.claude/shell-snapshots",
  "~/.claude/transcripts",
  "~/.claude/file-history",
  "~/.claude/paste-cache",
  "~/.codex/sessions",
  "~/.codex/archived_sessions",
  "~/.codex/history.jsonl",
  "~/.codex/*.sqlite*",
  "~/.codex/log",
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

export function agentEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  if (!env.HOME) throw new Error("agentEnv: HOME is required for CLI auth");
  // A relative or empty PATH entry resolves against the agent's cwd, the agent-writable worktree.
  if (env.PATH !== undefined) env.PATH = env.PATH.split(":").filter((d) => d.startsWith("/")).join(":");
  return env;
}
