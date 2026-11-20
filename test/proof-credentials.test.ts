import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedSource, proofSource } from "../scripts/probe-sources";
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

test("home-source controls refuse a shared login before planting any file", () => {
  for (const harness of ["claude","codex"] as const) {
    for (const test of ["S1-config","S1-home-claude","S1-home-agents","S8-config","S8-home-claude","S7"])
      expect(() => proofSource(test, {harness, home, harnessHome: state, project: root, shared: true})).toThrow("disposable proof credential");
  }
  expect(readdirSync(home)).toEqual([]);
  expect(readdirSync(state)).toEqual([]);
  const canary = proofSource("S1-config", {harness: "claude", home, harnessHome: state, project: root, shared: false});
  expect(readFileSync(canary!.path, "utf8")).toContain(canary!.marker);
});

test("D3 inherits the selected definition while ordinary proof launches stay on Haiku low", () => {
  const fake=executable("claude",'printf "%s/%s" "$CLAUDE_CODE_SUBAGENT_MODEL" "$CLAUDE_CODE_EFFORT_LEVEL"');
  const key=security("software-factory.claude-oauth-token");
  expect(runClaudeProof(fake,[],root,home,state,key).stdout).toBe("haiku/low");
  expect(runClaudeProof(fake,[],root,home,state,key,true,true).stdout).toBe("/");
});
test("each pinned harness requires its own S2 positive and closes both sources under factory flags", () => {
  for(const h of ["claude","codex"] as const) {
    expect(expectedSource(h,"S2-project-claude",true)).toBe(h==="claude");
    expect(expectedSource(h,"S2-project-agents",true)).toBe(h==="codex");
    for(const test of ["S2-project-claude","S2-project-agents"]) expect(expectedSource(h,test,false)).toBe(false);
    expect(expectedSource(h,"S1-config",true)).toBe(true);
  }
});
