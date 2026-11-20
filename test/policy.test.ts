import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { runAgent } from "../src/dispatch";
import { join } from "node:path";
import { claudeArgs, claudeSettings } from "../src/dispatch/claude";
import { codexArgs, codexConfigArgs, codexReadable } from "../src/dispatch/codex";
import {
  agentEnv, assertPolicySound, assertWorktreeWritable, effectiveDenyRead, expandHome, MANDATORY_DENY_READ, type PolicyContext, type SandboxPolicy, SYSTEM_PATH_DIRS,
} from "../src/dispatch/policy";
import { gitWriteProtectedPaths } from "../src/dispatch/git";
import { makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
let ctx: PolicyContext;
beforeEach(() => {
  sb = makeSandbox();
  ctx = { accountHome: sb.home, stateRoot: sb.stateRoot, harnessHomes: Object.values(sb.config.harnessHomes) };
});
afterEach(() => sb.cleanup());

const policyOf = (extra: string[] = [], readable: string[] = [], denyWrite: string[] = []): SandboxPolicy => ({ denyRead: effectiveDenyRead(ctx, extra), readable, denyWrite });
const mandatory = () => MANDATORY_DENY_READ.map((p) => expandHome(p, sb.home));

/** The paths a generated Codex profile carries with the given access. */
function codexEntries(args: string[], access: "none" | "read"): string[] {
  const profile = args[args.indexOf("-c") + 1]!;
  return [...profile.matchAll(new RegExp(`("(?:[^"\\\\]|\\\\.)*")="${access}"`, "g"))].map((m) => JSON.parse(m[1]!));
}
const codexDenied = (args: string[]) => codexEntries(args, "none");

describe("agentEnv", () => {
  const input = (extra: Partial<Parameters<typeof agentEnv>[1]> = {}) => ({
    harness: "codex" as const, harnessHome: "/state/codex-home", trustedPath: "/opt/harness/bin:/usr/bin:/bin", accountHome: "/Users/owner", ...extra,
  });

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
      input(),
    );
    expect(env).toEqual({ HOME: "/Users/owner", PATH: "/opt/harness/bin:/usr/bin:/bin", LANG: "en_US.UTF-8", CODEX_HOME: "/state/codex-home" });
  });

  test("points each harness at its dedicated home from the config, never the parent's", () => {
    const parent = { CODEX_HOME: "/h/.codex", CLAUDE_CONFIG_DIR: "/h/.claude" };
    expect(agentEnv(parent, input({ harness: "claude", harnessHome: "/state/claude-home" }))).toMatchObject({ CLAUDE_CONFIG_DIR: "/state/claude-home" });
    expect(agentEnv(parent, input()).CODEX_HOME).toBe("/state/codex-home");
    expect(agentEnv(parent, input()).CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(() => agentEnv(parent, input({ harnessHome: "codex-home" }))).toThrow("must be absolute");
  });

  test("HOME is the account home, whatever HOME the factory inherited", () => {
    expect(agentEnv({ HOME: "/tmp/elsewhere" }, input()).HOME).toBe("/Users/owner");
    expect(agentEnv({}, input()).HOME).toBe("/Users/owner");
    expect(() => agentEnv({}, input({ accountHome: "owner" }))).toThrow("must be absolute");
  });

  test("PATH is the trusted one, never the parent's, even an absolute worktree entry", () => {
    const parent = { PATH: "/Users/owner/orca/workspaces/p/wt/node_modules/.bin:/usr/bin" };
    expect(agentEnv(parent, input()).PATH).toBe("/opt/harness/bin:/usr/bin:/bin");
  });

  test("an empty trusted PATH falls back to the system dirs; a relative entry is refused", () => {
    expect(agentEnv({}, input({ trustedPath: "" })).PATH).toBe(SYSTEM_PATH_DIRS.join(":"));
    expect(() => agentEnv({}, input({ trustedPath: "bin:/usr/bin" }))).toThrow("relative entry");
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

  test("~ expands to the account home, never to an inherited HOME", () => {
    const saved = process.env.HOME;
    process.env.HOME = "/tmp/not-the-owner";
    try {
      const denied = effectiveDenyRead(ctx);
      expect(denied).toContain(join(sb.home, ".ssh"));
      expect(denied.some((p) => p.startsWith("~") || p.startsWith("/tmp/not-the-owner"))).toBe(false);
    } finally {
      process.env.HOME = saved;
    }
  });

  test("denies the configured state root and both harness homes by realpath, wherever the state root is", () => {
    const denied = effectiveDenyRead(ctx);
    for (const p of [sb.stateRoot, ...Object.values(sb.config.harnessHomes)]) expect(denied).toContain(realpathSync(p));
    // An alternate state root is not ~/.software-factory, so only this entry protects it.
    expect(sb.stateRoot.startsWith(join(sb.home, ".software-factory"))).toBe(false);
  });

  test("a symlinked owner path is denied by its realpath too", () => {
    const real = join(sb.home, "ssh-real");
    mkdirSync(real);
    symlinkSync(real, join(sb.home, ".ssh"));
    const denied = effectiveDenyRead(ctx);
    expect(denied).toContain(join(sb.home, ".ssh"));
    expect(denied).toContain(realpathSync(real));
  });

  test("additions merge with the mandatory list, deduplicated; they can never shrink it", () => {
    const base = effectiveDenyRead(ctx);
    expect(base.slice(0, MANDATORY_DENY_READ.length)).toEqual(mandatory());
    expect(effectiveDenyRead(ctx, [])).toEqual(base);
    const more = effectiveDenyRead(ctx, ["/opt/secrets", "~/.ssh", "/opt/secrets"]);
    expect(more.filter((p) => p === "/opt/secrets")).toHaveLength(1);
    expect(more).toEqual(expect.arrayContaining(base));
  });

  test("rejects relative paths, which each harness would resolve differently", () => {
    expect(() => effectiveDenyRead(ctx, ["secrets"])).toThrow("absolute or ~/-relative");
  });

  test("a readable carve-out may not reopen the state root or a harness home, nor equal a deny entry", () => {
    const denied = effectiveDenyRead(ctx);
    expect(() => assertPolicySound({ denyRead: denied, readable: [join(sb.stateRoot, "logs")], denyWrite: [] }, ctx)).toThrow("overlaps factory state");
    expect(() => assertPolicySound({ denyRead: denied, readable: [join(sb.config.harnessHomes.codex, "bin")], denyWrite: [] }, ctx)).toThrow("overlaps factory state");
    expect(() => assertPolicySound({ denyRead: denied, readable: [denied[0]!], denyWrite: [] }, ctx)).toThrow("Codex needs it readable");
    expect(() => assertPolicySound({ denyRead: denied, readable: [join(sb.home, ".codex", "packages", "bin")], denyWrite: [] }, ctx)).not.toThrow();
  });
});

describe("claude", () => {
  test.each([[[]], [["/opt/secrets"]]])("generated policy with extra deny %p still carries every mandatory path", (extra: string[]) => {
    const s = claudeSettings(policyOf(extra)) as any;
    const expected = [...mandatory(), ...extra, realpathSync(sb.stateRoot)];
    expect(s.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(expected));
    for (const p of expected) expect(s.permissions.deny).toContain(`Read(/${p})`);
  });

  test("settings deny the paths to both the Read tool and sandboxed Bash, with no network", () => {
    const s = claudeSettings(policyOf(["/opt/secrets"])) as any;
    const ssh = join(sb.home, ".ssh");
    expect(s.permissions.deny).toEqual(expect.arrayContaining(["WebFetch", "WebSearch", `Read(/${ssh})`, `Read(/${ssh}/**)`, "Read(//opt/secrets)", "Read(//opt/secrets/**)"]));
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(s.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: [] } });
  });

  test("args carry the proven flags and end the options before the prompt", () => {
    const args = claudeArgs({ prompt: "--help", model: "haiku", effort: "low", sessionId: "id", policy: policyOf() });
    expect(args[0]).toBe("-p");
    for (const flag of ["--restricted", "--strict-mcp-config", "--disable-slash-commands", "--verbose"]) expect(args).toContain(flag);
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "dontAsk"]);
    expect(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);
    expect(args.slice(-2)).toEqual(["--", "--help"]);
  });
});

describe("codex", () => {
  test.each([[[]], [["/opt/secrets"]]])("generated profile with extra deny %p still carries every mandatory path", (extra: string[]) => {
    expect(codexDenied(codexConfigArgs(policyOf(extra)))).toEqual(effectiveDenyRead(ctx, extra));
    expect(codexDenied(codexConfigArgs(policyOf(extra)))).toEqual(expect.arrayContaining([...mandatory(), ...extra, realpathSync(sb.stateRoot)]));
  });

  /** A Codex install under the denied ~/.codex, laid out like the standalone package. */
  const installCodex = () => {
    const bin = join(sb.home, ".codex", "packages", "standalone", "releases", "0.0.0", "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(bin, "..", "codex-resources"));
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
    symlinkSync(join(bin, "codex"), join(sb.home, "codex-link"));
    return bin;
  };

  test("reopens only the verified executable's own dir, found through its realpath, and nothing when it is not denied", () => {
    const bin = installCodex();
    const denied = effectiveDenyRead(ctx);
    expect(codexReadable(join(sb.home, "codex-link"), denied)).toEqual([realpathSync(bin)]);
    expect(codexReadable(sb.config.executables.codex, denied)).toEqual([]);
  });

  test("carries the readable carve-outs as read entries, and refuses one that is also denied", () => {
    const readable = codexReadable(join(installCodex(), "codex"), effectiveDenyRead(ctx));
    expect(codexEntries(codexConfigArgs(policyOf([], readable)), "read")).toEqual(readable);
    expect(() => codexConfigArgs(policyOf([readable[0]!], readable))).toThrow("Codex needs it readable");
  });

  test("config builds a named profile, escapes TOML strings, and selects the profile", () => {
    const args = codexConfigArgs(policyOf(['/odd "path"']));
    expect(args[1]).toStartWith(`permissions={factory={extends=":workspace", filesystem={${JSON.stringify(join(sb.home, ".software-factory"))}="none",`);
    expect(args[1]).toContain(',"/odd \\"path\\""="none",');
    expect(args.slice(2, 8)).toEqual(["-c", 'default_permissions="factory"', "-c", 'shell_environment_policy.inherit="core"', "-c", "allow_login_shell=false"]);
  });

  test("turns off everything a dedicated home does not: web search, skills, plugins, apps, hooks, image generation", () => {
    const flags = codexConfigArgs(policyOf()).filter((_, i, a) => a[i - 1] === "-c");
    for (const kv of [
      'web_search="disabled"', "skills.include_instructions=false", "skills.bundled.enabled=false",
      "features.plugins=false", "features.remote_plugin=false", "features.apps=false", "features.hooks=false", "features.image_generation=false",
    ]) {
      expect(flags).toContain(kv);
    }
  });

  test("args never pass --sandbox, which silently overrides default_permissions", () => {
    const args = codexArgs({ prompt: "-x", model: "gpt-6-luna", effort: "low", worktreePath: "/w", policy: policyOf() });
    expect(args[0]).toBe("exec");
    expect(args).not.toContain("-s");
    expect(args).not.toContain("--sandbox");
    for (const flag of ["--json", "--ignore-user-config", "--ignore-rules"]) expect(args).toContain(flag);
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args.slice(-2)).toEqual(["--", "-x"]);
  });
});

describe("git dir writes", () => {
  const GIT_ENV = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["/usr/bin/git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { env: GIT_ENV });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  /** A main checkout under the state root and a linked worktree under the agent-writable temp worktree. */
  const linkedWorktree = () => {
    const main = join(sb.stateRoot, "main");
    mkdirSync(main);
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "base");
    const wt = join(realpathSync(sb.worktree), "linked");
    git(main, "worktree", "add", "-q", "-b", "agent", wt);
    return { main: realpathSync(main), wt, common: join(realpathSync(main), ".git"), admin: join(realpathSync(main), ".git", "worktrees", "linked") };
  };

  test("a linked worktree protects the common git dir, its admin dir, and its .git link, canonical", () => {
    const { wt, common, admin } = linkedWorktree();
    expect(gitWriteProtectedPaths("/usr/bin/git", wt)).toEqual([common, admin, join(wt, ".git")]);
    // A link that reaches the same git dir through a symlink still yields the canonical paths.
    symlinkSync(join(sb.stateRoot, "main"), join(sb.stateRoot, "main-link"));
    writeFileSync(join(wt, ".git"), `gitdir: ${join(sb.stateRoot, "main-link", ".git", "worktrees", "linked")}\n`);
    expect(gitWriteProtectedPaths("/usr/bin/git", wt)).toEqual([common, admin, join(wt, ".git")]);
  });

  test("a dir that is not in any repository has nothing to protect, but a broken .git link refuses", () => {
    expect(gitWriteProtectedPaths("/usr/bin/git", realpathSync(sb.worktree))).toEqual([]);
    writeFileSync(join(sb.worktree, ".git"), "gitdir: /nonexistent/elsewhere\n");
    expect(() => gitWriteProtectedPaths("/usr/bin/git", realpathSync(sb.worktree))).toThrow("not a git repository");
  });

  test("Claude denies them to sandboxed Bash and to the Edit and Write tools", () => {
    const s = claudeSettings(policyOf([], [], ["/r/.git", "/r/.git/worktrees/w"])) as any;
    expect(s.sandbox.filesystem.denyWrite).toEqual(["/r/.git", "/r/.git/worktrees/w"]);
    for (const tool of ["Edit", "Write"]) {
      expect(s.permissions.deny).toEqual(expect.arrayContaining([`${tool}(//r/.git)`, `${tool}(//r/.git/**)`, `${tool}(//r/.git/worktrees/w)`, `${tool}(//r/.git/worktrees/w/**)`]));
    }
  });

  test("Codex makes them read-only, and a path also read-denied stays denied without a duplicate key", () => {
    const args = codexConfigArgs(policyOf(["/r/.git/worktrees/w"], [], ["/r/.git", "/r/.git/worktrees/w"]));
    expect(codexEntries(args, "read")).toEqual(["/r/.git"]);
    expect(codexDenied(args)).toContain("/r/.git/worktrees/w");
  });

  test("a write-deny covering the worktree is refused", () => {
    expect(() => assertWorktreeWritable({ denyRead: [], readable: [], denyWrite: ["/r"] }, "/r/wt")).toThrow("would cover the worktree");
    expect(() => assertWorktreeWritable({ denyRead: [], readable: [], denyWrite: ["/r/.git"] }, "/r/wt")).not.toThrow();
  });

  test("runAgent passes the worktree's git dirs to both harnesses", async () => {
    const { wt, common, admin } = linkedWorktree();
    const argvOf = () => readFileSync(join(wt, "argv0"), "utf8").split("\0").slice(0, -1);
    const base = { worktreePath: wt, prompt: `dump:${wt}`, model: "m", effort: "low", logDir: sb.logDir, timeoutMs: 30_000, instructions: null };
    await runAgent({ ...base, harness: "claude", runId: crypto.randomUUID() }, sb.config);
    const settings = JSON.parse(argvOf()[argvOf().indexOf("--settings") + 1]!);
    expect(settings.sandbox.filesystem.denyWrite).toEqual([common, admin, join(wt, ".git"), ...Object.values(sb.config.harnessHomes)]);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([`Write(/${common}/**)`, `Edit(/${admin}/**)`]));
    await runAgent({ ...base, harness: "codex", runId: crypto.randomUUID() }, sb.config);
    const codexArgv = argvOf();
    const profile = codexArgv.findIndex((a) => a.startsWith("permissions="));
    expect(codexEntries(codexArgv.slice(profile - 1), "read")).toEqual(expect.arrayContaining([common, admin, join(wt, ".git")]));
    expect(codexDenied(codexArgv.slice(profile - 1))).toEqual(expect.arrayContaining(Object.values(sb.config.harnessHomes)));
  });
});
