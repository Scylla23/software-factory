import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentEnv } from "../src/dispatch/policy";

const account = "software-factory";
const service = {
  claude: "software-factory.claude-oauth-token",
  codex: "software-factory.openai-proof-api-key",
} as const;

function proofCredential(harness: keyof typeof service, security: string) {
  const result = spawnSync(security, ["find-generic-password", "-s", service[harness], "-a", account, "-w"], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"], timeout: 5000, maxBuffer: 8192,
  });
  if (result.status === 44) throw new Error(`${harness} proof credential not provisioned`);
  if (result.error || result.status !== 0) throw new Error(`${harness} proof credential unavailable`);
  try {
    const token = result.stdout.toString("utf8").replace(/\r?\n$/, "");
    if (!/^[\x21-\x7e]+$/.test(token)) throw new Error(`${harness} proof credential is invalid`);
    return token;
  } finally { result.stdout.fill(0); }
}

/** Captures CLI output in memory and scrubs it before a caller can log it. */
export function runClaudeProof(executable: string, args: string[], cwd: string, home: string, configDir: string, security = "/usr/bin/security", limitDepth = true) {
  const token = proofCredential("claude", security);
  const env = agentEnv(process.env, { harness: "claude", accountHome: home, harnessHome: configDir, trustedPath: "/usr/bin:/bin" });
  const child = spawnSync(executable, args, {
    cwd, env: { ...env, CLAUDE_CODE_SUBAGENT_MODEL: "haiku", CLAUDE_CODE_EFFORT_LEVEL: "low", ...(limitDepth ? { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" } : {}), CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" },
    stdio: ["ignore", "pipe", "ignore"], timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
  });
  if (child.error || child.status === null) throw new Error("Claude proof process did not finish cleanly");
  try {
    return { status: child.status, stdout: child.stdout.toString("utf8").replaceAll(token, "[redacted]") };
  } finally { child.stdout.fill(0); }
}

/** The independently issued proof key exists on disk only inside this private, single-use CLI home. */
export async function withCodexProofLogin<T>(
  executable: string, state: string, home: string, run: (codexHome: string) => Promise<T>, security = "/usr/bin/security",
): Promise<T> {
  const key = proofCredential("codex", security);
  const codexHome = mkdtempSync(join(state, "proof-codex-"));
  const input = Buffer.from(key + "\n");
  try {
    const env = agentEnv(process.env, { harness: "codex", accountHome: home, harnessHome: codexHome, trustedPath: "/usr/bin:/bin" });
    const login = spawnSync(executable, ["login", "-c", 'cli_auth_credentials_store="file"', "--with-api-key"], {
      env, cwd: codexHome, input, stdio: ["pipe", "ignore", "ignore"], timeout: 15_000, killSignal: "SIGKILL",
    });
    if (login.error || login.status !== 0) throw new Error("Codex disposable login failed");
    return await run(codexHome);
  } catch (error) {
    throw new Error(String(error instanceof Error ? error.message : error).replaceAll(key, "[redacted]"));
  } finally {
    input.fill(0);
    rmSync(codexHome, { recursive: true, force: true });
  }
}
