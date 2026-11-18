import { describe, expect, test } from "bun:test";
import { claudeCommand, claudeSettings } from "../src/dispatch/claude";
import { codexCommand, codexConfigArgs } from "../src/dispatch/codex";
import { agentEnv, DEFAULT_DENY_READ } from "../src/dispatch/policy";

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

  test("requires HOME, which both CLIs need to find their auth", () => {
    expect(() => agentEnv({ PATH: "/bin" })).toThrow("HOME is required");
  });
});

describe("deny-list", () => {
  test("covers the state dir and the credential stores the design names", () => {
    for (const p of ["~/.software-factory", "~/.ssh", "~/.config/gh", "~/Library/Keychains", "~/.codex/auth.json"]) {
      expect(DEFAULT_DENY_READ).toContain(p);
    }
  });

  test("never denies all of ~/.codex: Codex re-execs its own binary from there inside the sandbox", () => {
    expect(DEFAULT_DENY_READ).not.toContain("~/.codex");
  });

  test("rejects relative paths, which each harness would resolve differently", () => {
    expect(() => claudeSettings(["secrets"])).toThrow("absolute or ~/-relative");
    expect(() => codexConfigArgs(["secrets"])).toThrow("absolute or ~/-relative");
  });
});

describe("claude", () => {
  test("settings deny the paths to both the Read tool and sandboxed Bash, with no network", () => {
    const s = claudeSettings(["~/.ssh", "/opt/secrets"]) as any;
    expect(s.permissions.deny).toEqual(["WebFetch", "WebSearch", "Read(~/.ssh)", "Read(~/.ssh/**)", "Read(//opt/secrets)", "Read(//opt/secrets/**)"]);
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(s.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: [] } });
    expect(s.sandbox.filesystem.denyRead).toEqual(["~/.ssh", "/opt/secrets"]);
  });

  test("command carries the proven flags and ends the options before the prompt", () => {
    const cmd = claudeCommand({ prompt: "--help", model: "haiku", effort: "low", sessionId: "id", denyRead: ["~/.ssh"] });
    for (const flag of ["--restricted", "--strict-mcp-config", "--verbose"]) expect(cmd).toContain(flag);
    expect(cmd.slice(cmd.indexOf("--permission-mode"), cmd.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "dontAsk"]);
    expect(cmd.slice(cmd.indexOf("--output-format"), cmd.indexOf("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);
    expect(cmd.slice(-2)).toEqual(["--", "--help"]);
  });
});

describe("codex", () => {
  test("config builds a named profile with deny entries and selects it", () => {
    expect(codexConfigArgs(["~/.ssh", '/odd "path"'])).toEqual([
      "-c", 'permissions={factory={extends=":workspace", filesystem={"~/.ssh"="none","/odd \\"path\\""="none"}}}',
      "-c", 'default_permissions="factory"',
      "-c", 'shell_environment_policy.inherit="core"',
      "-c", "allow_login_shell=false",
    ]);
  });

  test("command never passes --sandbox, which silently overrides default_permissions", () => {
    const cmd = codexCommand({ prompt: "-x", model: "gpt-6-luna", effort: "low", worktreePath: "/w", denyRead: DEFAULT_DENY_READ });
    expect(cmd).not.toContain("-s");
    expect(cmd).not.toContain("--sandbox");
    for (const flag of ["--json", "--ignore-user-config", "--ignore-rules"]) expect(cmd).toContain(flag);
    expect(cmd).toContain('model_reasoning_effort="low"');
    expect(cmd.slice(-2)).toEqual(["--", "-x"]);
  });
});
