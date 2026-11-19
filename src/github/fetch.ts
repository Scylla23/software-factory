import type { InstallationToken } from "./app";

const FETCH_TIMEOUT_MS = 120_000;
const SHA = /^[0-9a-f]{40}$/;

/**
 * Fetches exact commits from GitHub into a factory-controlled checkout with an installation token, each kept alive by a
 * `refs/factory/commits/<sha>` ref so gc cannot prune it before it is materialized.
 * The token reaches git only as an `http.extraHeader` in the child's environment (GIT_CONFIG_*), never in argv, the
 * remote URL, or any config file, so nothing on disk keeps it. No system or global config, prompts, or hooks apply.
 */
export function fetchCommits(gitPath: string, repoDir: string, owner: string, repo: string, shas: readonly string[], token: InstallationToken): void {
  for (const part of [owner, repo]) if (!/^[A-Za-z0-9._-]{1,100}$/.test(part)) throw new Error(`not a GitHub name: ${JSON.stringify(part)}`);
  if (shas.length === 0 || shas.some((s) => !SHA.test(s))) throw new Error("fetchCommits needs full commit ids");
  const basic = Buffer.from(`x-access-token:${token.secret()}`).toString("base64");
  const r = Bun.spawnSync(
    [gitPath, "--no-replace-objects", "-C", repoDir, "-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", "--no-write-fetch-head", "--quiet", `https://github.com/${owner}/${repo}.git`, ...shas.map((s) => `+${s}:refs/factory/commits/${s}`)],
    {
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/usr/bin/false",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: FETCH_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  if (r.exitedDueToTimeout) throw new Error(`git fetch gave no answer within ${FETCH_TIMEOUT_MS}ms`);
  // git never prints extra headers; scrub anyway so a future git cannot leak the token through this message.
  const stderr = r.stderr.toString().replaceAll(basic, "[redacted]").replaceAll(token.secret(), "[redacted]").trim();
  if (r.exitCode !== 0) throw new Error(`git fetch from ${owner}/${repo} failed: ${stderr.slice(0, 300) || `exit ${r.exitCode}`}`);
}
