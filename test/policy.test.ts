import { describe, expect, test } from "bun:test";
import { claudeArgs, claudeSettings } from "../src/dispatch/claude";
import { codexArgs, codexConfigArgs } from "../src/dispatch/codex";
import { agentEnv, effectiveDenyRead, MANDATORY_DENY_READ } from "../src/dispatch/policy";

/** The deny paths a generated Codex profile actually carries. */
function codexDenied(args: string[]): string[] {
  const profile = args[args.indexOf("-c") + 1]!;
  return [...profile.matchAll(/("(?:[^"\\]|\\.)*")="none"/g)].map((m) => JSON.parse(m[1]!));
}

describe("agentEnv", () => {
  test("keeps only the allowlist, dropping canaries, tokens, and harness variables", () => {
    const env = agentEnv({
      HOME: "/Users/owner",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      FACTORY_CANARY: "CANARY-x",
      GITHUB_TOKEN: "t",
      ANTHROPIC_API_KEY: "k",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "s",
      ORCA_SESSION_ID: "o",
    });
    expect(env).toEqual({ HOME: "/Users/owner", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" });
  });

  test("drops relative and empty PATH entries, which would resolve inside the worktree", () => {
    expect(agentEnv({ HOME: "/h", PATH: "node_modules/.bin::.:/usr/bin:bin:/bin" }).PATH).toBe("/usr/bin:/bin");
  });

  test("requires HOME, which both CLIs need to find their auth", () => {
    expect(() => agentEnv({ PATH: "/bin" })).toThrow("HOME is required");
  });
});

describe("deny-list", () => {
  test("covers the state dir, credential stores, and the owner's session history", () => {
    for (const p of [
      "~/.software-factory", "~/.ssh", "~/.config/gh", "~/Library/Keychains", "~/.codex/auth.json",
      "~/.claude/projects", "~/.claude/history.jsonl", "~/.claude/shell-snapshots",
      "~/.codex/sessions", "~/.codex/archived_sessions", "~/.codex/history.jsonl", "~/.codex/*.sqlite*",
      "~/Library/Application Support/orca",
    ]) {
      expect(MANDATORY_DENY_READ).toContain(p);
    }
  });

  test("never denies all of ~/.codex: Codex re-execs its own binary from there inside the sandbox", () => {
    expect(MANDATORY_DENY_READ).not.toContain("~/.codex");
  });

  test("additions merge with the mandatory list, deduplicated; they can never shrink it", () => {
    expect(effectiveDenyRead()).toEqual([...MANDATORY_DENY_READ]);
    expect(effectiveDenyRead([])).toEqual([...MANDATORY_DENY_READ]);
    expect(effectiveDenyRead(["/opt/secrets", "~/.ssh", "/opt/secrets"])).toEqual([...MANDATORY_DENY_READ, "/opt/secrets"]);
  });

  test("rejects relative paths, which each harness would resolve differently", () => {
    expect(() => claudeSettings(["secrets"])).toThrow("absolute or ~/-relative");
    expect(() => codexConfigArgs(["secrets"])).toThrow("absolute or ~/-relative");
  });
});

describe("claude", () => {
  test.each([[[]], [["/opt/secrets"]]])("generated policy with extra deny %p still carries every mandatory path", (extra: string[]) => {
    const s = claudeSettings(extra) as any;
    const expected = [...MANDATORY_DENY_READ, ...extra];
    expect(s.sandbox.filesystem.denyRead).toEqual(expected);
    for (const p of expected) expect(s.permissions.deny).toContain(`Read(${p.startsWith("/") ? `/${p}` : p})`);
  });

  test("settings deny the paths to both the Read tool and sandboxed Bash, with no network", () => {
    const s = claudeSettings(["/opt/secrets"]) as any;
    expect(s.permissions.deny).toEqual(expect.arrayContaining(["WebFetch", "WebSearch", "Read(~/.ssh)", "Read(~/.ssh/**)", "Read(//opt/secrets)", "Read(//opt/secrets/**)"]));
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(s.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: [] } });
  });

  test("args carry the proven flags and end the options before the prompt", () => {
    const args = claudeArgs({ prompt: "--help", model: "haiku", effort: "low", sessionId: "id" });
    expect(args[0]).toBe("-p");
    for (const flag of ["--restricted", "--strict-mcp-config", "--verbose"]) expect(args).toContain(flag);
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "dontAsk"]);
    expect(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);
    expect(args.slice(-2)).toEqual(["--", "--help"]);
  });
});

describe("codex", () => {
  test.each([[[]], [["/opt/secrets"]]])("generated profile with extra deny %p still carries every mandatory path", (extra: string[]) => {
    expect(codexDenied(codexConfigArgs(extra))).toEqual([...MANDATORY_DENY_READ, ...extra]);
  });

  test("config builds a named profile, escapes TOML strings, and selects the profile", () => {
    const args = codexConfigArgs(['/odd "path"']);
    expect(args[1]).toStartWith('permissions={factory={extends=":workspace", filesystem={"~/.software-factory"="none",');
    expect(args[1]).toEndWith(',"/odd \\"path\\""="none"}}}');
    expect(args.slice(2)).toEqual(["-c", 'default_permissions="factory"', "-c", 'shell_environment_policy.inherit="core"', "-c", "allow_login_shell=false"]);
  });

  test("args never pass --sandbox, which silently overrides default_permissions", () => {
    const args = codexArgs({ prompt: "-x", model: "gpt-6-luna", effort: "low", worktreePath: "/w" });
    expect(args[0]).toBe("exec");
    expect(args).not.toContain("-s");
    expect(args).not.toContain("--sandbox");
    for (const flag of ["--json", "--ignore-user-config", "--ignore-rules"]) expect(args).toContain(flag);
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args.slice(-2)).toEqual(["--", "-x"]);
  });
});
