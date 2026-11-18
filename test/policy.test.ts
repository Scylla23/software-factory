import { describe, expect, test } from "bun:test";
import { claudeArgs, claudeSettings } from "../src/dispatch/claude";
import { CODEX_READ_EXCEPTIONS, codexArgs, codexConfigArgs } from "../src/dispatch/codex";
import { agentEnv, effectiveDenyRead, MANDATORY_DENY_READ } from "../src/dispatch/policy";

/** The paths a generated Codex profile carries with the given access. */
function codexEntries(args: string[], access: "none" | "read"): string[] {
  const profile = args[args.indexOf("-c") + 1]!;
  return [...profile.matchAll(new RegExp(`("(?:[^"\\\\]|\\\\.)*")="${access}"`, "g"))].map((m) => JSON.parse(m[1]!));
}
const codexDenied = (args: string[]) => codexEntries(args, "none");

describe("agentEnv", () => {
  test("keeps only the allowlist, dropping canaries, tokens, and harness variables", () => {
    const env = agentEnv(
      {
      HOME: "/Users/owner",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      FACTORY_CANARY: "CANARY-x",
      GITHUB_TOKEN: "t",
      ANTHROPIC_API_KEY: "k",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "s",
      ORCA_SESSION_ID: "o",
      CODEX_HOME: "/Users/owner/.codex",
      CLAUDE_CONFIG_DIR: "/Users/owner/.claude",
      },
      "codex",
      "/state/codex-home",
    );
    expect(env).toEqual({ HOME: "/Users/owner", PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", CODEX_HOME: "/state/codex-home" });
  });

  test("points each harness at its dedicated home from the config, never the parent's", () => {
    const parent = { HOME: "/h", CODEX_HOME: "/h/.codex", CLAUDE_CONFIG_DIR: "/h/.claude" };
    expect(agentEnv(parent, "claude", "/state/claude-home")).toEqual({ HOME: "/h", CLAUDE_CONFIG_DIR: "/state/claude-home" });
    expect(agentEnv(parent, "codex", "/state/codex-home")).toEqual({ HOME: "/h", CODEX_HOME: "/state/codex-home" });
    expect(() => agentEnv(parent, "codex", "codex-home")).toThrow("must be absolute");
  });

  test("drops relative and empty PATH entries, which would resolve inside the worktree", () => {
    expect(agentEnv({ HOME: "/h", PATH: "node_modules/.bin::.:/usr/bin:bin:/bin" }, "codex", "/c").PATH).toBe("/usr/bin:/bin");
  });

  test("requires HOME, which both CLIs need to find their auth", () => {
    expect(() => agentEnv({ PATH: "/bin" }, "codex", "/c")).toThrow("HOME is required");
  });
});

describe("deny-list", () => {
  test("covers the state dir with the harness homes, credential stores, and the owner's whole harness homes", () => {
    for (const p of [
      "~/.software-factory", "~/.ssh", "~/.config/gh", "~/Library/Keychains",
      "~/.claude", "~/.claude.json", "~/.codex", "~/.agents", "~/Library/Application Support/orca",
    ]) {
      expect(MANDATORY_DENY_READ).toContain(p);
    }
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
    for (const flag of ["--restricted", "--strict-mcp-config", "--disable-slash-commands", "--verbose"]) expect(args).toContain(flag);
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "dontAsk"]);
    expect(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);
    expect(args.slice(-2)).toEqual(["--", "--help"]);
  });
});

describe("codex", () => {
  test.each([[[]], [["/opt/secrets"]]])("generated profile with extra deny %p still carries every mandatory path", (extra: string[]) => {
    expect(codexDenied(codexConfigArgs(extra))).toEqual([...MANDATORY_DENY_READ, ...extra]);
  });

  test("gives back read access only to ~/.codex/packages, where Codex's sandbox helper re-execs its binary", () => {
    expect(CODEX_READ_EXCEPTIONS).toEqual(["~/.codex/packages"]);
    expect(codexEntries(codexConfigArgs(), "read")).toEqual(["~/.codex/packages"]);
    expect(() => codexConfigArgs(["~/.codex/packages"])).toThrow("Codex needs it readable");
  });

  test("config builds a named profile, escapes TOML strings, and selects the profile", () => {
    const args = codexConfigArgs(['/odd "path"']);
    expect(args[1]).toStartWith('permissions={factory={extends=":workspace", filesystem={"~/.software-factory"="none",');
    expect(args[1]).toEndWith(',"/odd \\"path\\""="none","~/.codex/packages"="read"}}}');
    expect(args.slice(2, 8)).toEqual(["-c", 'default_permissions="factory"', "-c", 'shell_environment_policy.inherit="core"', "-c", "allow_login_shell=false"]);
  });

  test("turns off everything a dedicated home does not: web search, skills, plugins, apps, hooks, image generation", () => {
    const flags = codexConfigArgs().filter((_, i, a) => a[i - 1] === "-c");
    for (const kv of [
      'web_search="disabled"', "skills.include_instructions=false", "skills.bundled.enabled=false",
      "features.plugins=false", "features.remote_plugin=false", "features.apps=false", "features.hooks=false", "features.image_generation=false",
    ]) {
      expect(flags).toContain(kv);
    }
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
