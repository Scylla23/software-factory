import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, type RunSpec } from "../src/dispatch";
import { claudeArgs } from "../src/dispatch/claude";
import { codexArgs, tomlString } from "../src/dispatch/codex";
import { buildProjectInstructions, type InstructionSource, MAX_INSTRUCTIONS_BYTES, PROJECT_INSTRUCTION_PATHS } from "../src/dispatch/instructions";
import { makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
/** A factory-controlled git checkout of the project, outside every agent-writable root. */
let repo: string;
/** A git wrapper that logs each call's argv, so tests can see which reads happened. */
let gitLog: string;
let tracingGit: string;
const GIT_ENV = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (...args: string[]): string => {
  const r = Bun.spawnSync(["/usr/bin/git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
/** Stages everything in the checkout and returns the new commit id. */
const commit = (): string => {
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "c");
  return git("rev-parse", "HEAD");
};
beforeEach(() => {
  sb = makeSandbox();
  repo = join(sb.stateRoot, "checkout");
  mkdirSync(repo);
  git("init", "-q");
  gitLog = join(sb.bin, "git-calls");
  tracingGit = join(sb.bin, "tracing-git");
  writeFileSync(tracingGit, `#!/bin/sh\nprintf '%s ' "$@" >> '${gitLog}'; echo >> '${gitLog}'\nexec /usr/bin/git "$@"\n`);
  chmodSync(tracingGit, 0o755);
});
afterEach(() => sb.cleanup());

const source = (baseSha: string, paths: readonly string[] = PROJECT_INSTRUCTION_PATHS): InstructionSource => ({ repo, baseSha, paths });
const build = (src: InstructionSource, roots: readonly string[] = [sb.worktree]) => buildProjectInstructions(src, "/usr/bin/git", roots);

function spec(harness: RunSpec["harness"], extra: Partial<RunSpec> = {}): RunSpec {
  return {
    harness, worktreePath: sb.worktree, prompt: `dump:${sb.worktree}`, model: "requested", effort: "low",
    logDir: sb.logDir, runId: crypto.randomUUID(), timeoutMs: 30_000, instructions: null, ...extra,
  };
}
const argv = () => readFileSync(join(sb.worktree, "argv0"), "utf8").split("\0").slice(0, -1);
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
/**
 * TOML basic-string grammar: no raw `"`, `\\`, control characters, or DEL, and only these escapes.
 * Its escapes mean the same in JSON, so JSON.parse decodes it; Bun 1.2.10's own TOML parser misreads `\\t`.
 */
const TOML_BASIC_STRING = /^"(?:[^"\\\x00-\x1f\x7f]|\\[btnfr"\\]|\\u[0-9A-Fa-f]{4})*"$/;
const tomlDecode = (lit: string): string => {
  expect(lit).toMatch(TOML_BASIC_STRING);
  return JSON.parse(lit);
};
const codexConfig = (args: string[], key: string): unknown => {
  const kv = args.find((a, i) => args[i - 1] === "-c" && a.startsWith(`${key}=`));
  if (kv === undefined) return undefined;
  const value = kv.slice(key.length + 1);
  return value.startsWith('"') ? tomlDecode(value) : Number(value);
};

describe("buildProjectInstructions", () => {
  test("wraps each file once, in order, and returns null when the commit has none", () => {
    const empty = commit();
    expect(build(source(empty))).toBeNull();
    writeFileSync(join(repo, "AGENTS.md"), "Use bun.\n");
    writeFileSync(join(repo, "CLAUDE.md"), "No dashes.");
    const text = build(source(commit()))!;
    expect(text).toContain('<file name="AGENTS.md">\nUse bun.\n</file>\n\n<file name="CLAUDE.md">\nNo dashes.\n</file>');
    expect(text.indexOf("AGENTS.md")).toBeLessThan(text.indexOf("CLAUDE.md"));
  });

  test("a path the commit lacks is skipped", () => {
    writeFileSync(join(repo, "AGENTS.md"), "only agents");
    const text = build(source(commit()))!;
    expect(text).toContain('<file name="AGENTS.md">');
    expect(text).not.toContain("CLAUDE.md");
  });

  test("a CLAUDE.md with the same blob as AGENTS.md is included once", () => {
    writeFileSync(join(repo, "AGENTS.md"), "once");
    writeFileSync(join(repo, "CLAUDE.md"), "once");
    const text = build(source(commit()))!;
    expect(text.split("once")).toHaveLength(2);
  });

  test("a symlinked AGENTS.md pointing at an outside canary is refused, and the canary is never read", () => {
    const canary = join(sb.home, "canary");
    writeFileSync(canary, "CANARY-SECRET");
    symlinkSync(canary, join(repo, "AGENTS.md"));
    const sha = commit();
    expect(() => buildProjectInstructions(source(sha), tracingGit, [])).toThrow("is a symlink");
    expect(readFileSync(gitLog, "utf8")).not.toContain("cat-file");
  });

  test("an in-repo symlink alias is refused too: only regular files count", () => {
    writeFileSync(join(repo, "AGENTS.md"), "once");
    symlinkSync("AGENTS.md", join(repo, "CLAUDE.md"));
    expect(() => build(source(commit()))).toThrow("CLAUDE.md is a symlink");
  });

  test("a directory or submodule-like entry is not a regular file", () => {
    mkdirSync(join(repo, "AGENTS.md"));
    writeFileSync(join(repo, "AGENTS.md", "x"), "x");
    expect(() => build(source(commit()))).toThrow("not a regular file");
  });

  test("working-tree edits, untracked files, and later commits are not seen", () => {
    writeFileSync(join(repo, "AGENTS.md"), "approved\n");
    const base = commit();
    writeFileSync(join(repo, "AGENTS.md"), "edited after the base\n");
    writeFileSync(join(repo, "CLAUDE.md"), "untracked\n");
    expect(build(source(base))).toContain("approved\n");
    expect(build(source(base))).not.toMatch(/edited|untracked/);
    commit();
    expect(build(source(base))).not.toMatch(/edited|untracked/);
  });

  test("a sibling worktree's files and commits are irrelevant", () => {
    writeFileSync(join(repo, "AGENTS.md"), "approved\n");
    const base = commit();
    const sibling = join(sb.stateRoot, "sibling");
    git("worktree", "add", "-q", "-b", "agent", sibling, base);
    writeFileSync(join(sibling, "AGENTS.md"), "sibling edit\n");
    Bun.spawnSync(["/usr/bin/git", "-C", sibling, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "s"], { env: GIT_ENV });
    expect(build(source(base))).toContain("approved\n");
    expect(build(source(base))).not.toContain("sibling");
  });

  test("oversize instructions are refused before any blob is read", () => {
    writeFileSync(join(repo, "AGENTS.md"), "x".repeat(MAX_INSTRUCTIONS_BYTES / 2));
    writeFileSync(join(repo, "CLAUDE.md"), "y".repeat(MAX_INSTRUCTIONS_BYTES / 2 + 1));
    const sha = commit();
    expect(() => buildProjectInstructions(source(sha), tracingGit, [])).toThrow("exceed");
    const calls = readFileSync(gitLog, "utf8");
    expect(calls).toContain("cat-file -s");
    expect(calls).not.toContain("cat-file blob");
  });

  test("refuses bad commits, bad paths, invalid UTF-8, and a repo an agent can write", () => {
    writeFileSync(join(repo, "bad.md"), Buffer.from([0xff, 0xfe]));
    const sha = commit();
    expect(() => build(source("HEAD"))).toThrow("full lowercase commit id");
    expect(() => build(source(sha.slice(0, 12)))).toThrow("full lowercase commit id");
    expect(() => build(source("0".repeat(40)))).toThrow("is not a commit");
    expect(() => build(source(git("rev-parse", "HEAD^{tree}")))).toThrow("is not a commit");
    for (const p of ["../AGENTS.md", "/AGENTS.md", "a//b", "./AGENTS.md", "-p", ":(top)AGENTS.md", "*.md"]) {
      expect(() => build(source(sha, [p]))).toThrow("plain segments");
    }
    expect(() => build(source(sha, ["bad.md"]))).toThrow("UTF-8");
    expect(() => build(source(sha), [sb.stateRoot])).toThrow("agent-writable");
    expect(() => build({ repo: "checkout", baseSha: sha, paths: [] })).toThrow("absolute");
  });
});

describe("tomlString", () => {
  test.each([["plain"], ['quote " and \\ backslash'], ["lines\nand\ttabs\r\n"], ["del \x7f and \x01 controls"], ["unicode é 🦤"]])(
    "round-trips %p through TOML",
    (s) => {
      expect(tomlDecode(tomlString(s))).toBe(s);
    },
  );
});

const NO_POLICY = { denyRead: ["/denied"], readable: [] };

describe("harness args", () => {
  test("Claude appends the instructions file to the system prompt, before the end of options", () => {
    const args = claudeArgs({ prompt: "p", model: "m", effort: "low", sessionId: "s", policy: NO_POLICY, instructionsFile: "/state/i.md" });
    expect(after(args, "--append-system-prompt-file")).toBe("/state/i.md");
    expect(args.indexOf("--append-system-prompt-file")).toBeLessThan(args.indexOf("--"));
    expect(claudeArgs({ prompt: "p", model: "m", effort: "low", sessionId: "s", policy: NO_POLICY })).not.toContain("--append-system-prompt-file");
  });

  test("Codex always turns off its own AGENTS.md discovery, with or without instructions", () => {
    const none = codexArgs({ prompt: "p", model: "m", effort: "low", worktreePath: "/w", policy: NO_POLICY });
    expect(codexConfig(none, "project_doc_max_bytes")).toBe(0);
    expect(codexConfig(none, "developer_instructions")).toBeUndefined();
    const some = codexArgs({ prompt: "p", model: "m", effort: "low", worktreePath: "/w", policy: NO_POLICY, instructions: "Use bun.\n" });
    expect(codexConfig(some, "project_doc_max_bytes")).toBe(0);
    expect(codexConfig(some, "developer_instructions")).toBe("Use bun.\n");
  });
});

describe("runAgent with project instructions", () => {
  test("both harnesses receive byte-identical instructions, and the run keeps the exact copy", async () => {
    writeFileSync(join(repo, "AGENTS.md"), "The project codeword is PELICAN.\n");
    writeFileSync(join(repo, "CLAUDE.md"), 'Quote "this" \\ and keep\nnewlines.\n');
    const instructions = source(commit());
    const expected = build(instructions)!;

    const c = await runAgent(spec("claude", { instructions }), sb.config);
    const claudeFile = after(argv(), "--append-system-prompt-file")!;
    expect(claudeFile).toBe(c.instructionsPath!);
    expect(readFileSync(claudeFile, "utf8")).toBe(expected);

    const x = await runAgent(spec("codex", { instructions }), sb.config);
    expect(codexConfig(argv(), "developer_instructions")).toBe(expected);
    expect(readFileSync(x.instructionsPath!, "utf8")).toBe(expected);
  });

  test("no instructions: none passed and no instructions file", async () => {
    const c = await runAgent(spec("claude"), sb.config);
    expect(argv()).not.toContain("--append-system-prompt-file");
    expect(c.instructionsPath).toBeNull();
  });

  test("a run rejected after its checks leaves no open descriptors and does not use the attempt id", async () => {
    writeFileSync(join(repo, "AGENTS.md"), "x\n");
    const s = spec("claude", { instructions: source(commit()) });
    const planted = join(sb.logDir, `${s.runId}.instructions.md`);
    mkdirSync(planted);
    const before = readdirSync("/dev/fd").length;
    await expect(runAgent(s, sb.config)).rejects.toThrow();
    expect(readdirSync("/dev/fd").length).toBe(before);
    expect(readdirSync(sb.logDir)).toEqual([`${s.runId}.instructions.md`]);
    rmSync(planted, { recursive: true });
    expect((await runAgent(s, sb.config)).outcome).toBe("completed");
  });

  test("a refused instruction source stops the run before anything starts", async () => {
    symlinkSync(join(sb.home, "canary"), join(repo, "AGENTS.md"));
    const marker = join(sb.worktree, "started");
    await expect(runAgent(spec("codex", { prompt: `started:${marker}`, instructions: source(commit()) }), sb.config)).rejects.toThrow("symlink");
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});
