import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeProof, withCodexProofLogin } from "../scripts/proof-credentials";

let root: string, home: string, state: string, secret: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "factory-proof-auth-"));
  home = join(root, "account");
  state = join(root, "state");
  mkdirSync(home);
  mkdirSync(state);
  secret = crypto.randomUUID();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function executable(name: string, body: string) {
  const path = join(root, name);
  writeFileSync(path, "#!/bin/sh\n" + body);
  chmodSync(path, 0o700);
  return path;
}
function security(service: string) {
  return executable("security", `[ "$*" = 'find-generic-password -s ${service} -a software-factory -w' ] || exit 2\nprintf '%s\\n' '${secret}'`);
}

test("Claude child gets a scrubbed environment and the caller gets only redacted diagnostics", () => {
  const fake = executable("claude", `[ "$#" = 1 ] && [ "$1" = probe ] || exit 2
[ "$CLAUDE_CODE_SUBPROCESS_ENV_SCRUB" = 1 ] && [ "$CLAUDE_CODE_OAUTH_TOKEN" = '${secret}' ] || exit 3
printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN"
printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" >&2`);
  const result = runClaudeProof(fake, ["probe"], root, home, state, security("software-factory.claude-oauth-token"));
  expect(result).toEqual({ status: 0, stdout: "[redacted]" });
  expect(readdirSync(state)).toEqual([]);
  expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).not.toBe(secret);
});
test("an absent credential refuses each proof before launch", async () => {
  const missing = executable("security", "exit 44");
  expect(() => runClaudeProof("/missing", [], root, home, state, missing)).toThrow("claude proof credential not provisioned");
  await expect(withCodexProofLogin("/missing", state, home, async () => "unexpected", missing)).rejects.toThrow("codex proof credential not provisioned");
  expect(readdirSync(state)).toEqual([]);
});
test("Codex reads its proof key from stdin and deletes its exclusive home even after a failed proof", async () => {
  const keychain = security("software-factory.openai-proof-api-key");
  const fake = executable("codex", `[ "$*" = 'login -c cli_auth_credentials_store="file" --with-api-key' ] || exit 2
[ -z "$OPENAI_API_KEY" ] || exit 3
umask 077
cat > "$CODEX_HOME/auth.json"`);
  for (const fail of [false, true]) {
    let disposable = "";
    const run = withCodexProofLogin(fake, state, home, async path => {
      disposable = path;
      expect(readFileSync(join(path, "auth.json"), "utf8")).toBe(secret + "\n");
      if (fail) throw new Error("diagnostic " + secret);
      return "passed";
    }, keychain);
    if (fail) await expect(run).rejects.toThrow("diagnostic [redacted]");
    else expect(await run).toBe("passed");
    expect(disposable).not.toBe("");
    expect(existsSync(disposable)).toBe(false);
  }
});
