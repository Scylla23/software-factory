import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, type RunSpec } from "../src/dispatch";
import { claudeArgs } from "../src/dispatch/claude";
import { codexArgs, tomlString } from "../src/dispatch/codex";
import { buildProjectInstructions, MAX_INSTRUCTIONS_BYTES, projectInstructionFiles } from "../src/dispatch/instructions";
import { makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
/** A factory-controlled checkout of the project, outside every agent-writable root. */
let checkout: string;
beforeEach(() => {
  sb = makeSandbox();
  checkout = join(sb.stateRoot, "checkout");
  mkdirSync(checkout);
});
afterEach(() => sb.cleanup());

function spec(harness: RunSpec["harness"], extra: Partial<RunSpec> = {}): RunSpec {
  return {
    harness, worktreePath: sb.worktree, prompt: `dump:${sb.worktree}`, model: "requested", effort: "low",
    logDir: sb.logDir, runId: crypto.randomUUID(), timeoutMs: 30_000, instructionFiles: [], ...extra,
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
  test("wraps each file once, in order, and returns null when there are none", () => {
    writeFileSync(join(checkout, "AGENTS.md"), "Use bun.\n");
    writeFileSync(join(checkout, "CLAUDE.md"), "No dashes.");
    const text = buildProjectInstructions(projectInstructionFiles(checkout), [sb.worktree])!;
    expect(text).toContain('<file name="AGENTS.md">\nUse bun.\n</file>\n\n<file name="CLAUDE.md">\nNo dashes.\n</file>');
    expect(text.indexOf("AGENTS.md")).toBeLessThan(text.indexOf("CLAUDE.md"));
    expect(buildProjectInstructions([], [sb.worktree])).toBeNull();
  });

  test("projectInstructionFiles lists only the files that exist", () => {
    expect(projectInstructionFiles(checkout)).toEqual([]);
    writeFileSync(join(checkout, "AGENTS.md"), "a");
    expect(projectInstructionFiles(checkout)).toEqual([join(checkout, "AGENTS.md")]);
  });

  test("a CLAUDE.md symlinked to AGENTS.md is included once", () => {
    writeFileSync(join(checkout, "AGENTS.md"), "once");
    symlinkSync("AGENTS.md", join(checkout, "CLAUDE.md"));
    const text = buildProjectInstructions(projectInstructionFiles(checkout), [])!;
    expect(text.split("once")).toHaveLength(2);
  });

  test("refuses files an agent can write, even through a symlink", () => {
    writeFileSync(join(sb.worktree, "AGENTS.md"), "planted");
    const roots = [realpathSync(sb.worktree)];
    expect(() => buildProjectInstructions([join(sb.worktree, "AGENTS.md")], roots)).toThrow("agent-writable");
    symlinkSync(join(sb.worktree, "AGENTS.md"), join(checkout, "AGENTS.md"));
    expect(() => buildProjectInstructions([join(checkout, "AGENTS.md")], roots)).toThrow("agent-writable");
  });

  test("refuses relative paths, directories, invalid UTF-8, and oversize instructions", () => {
    expect(() => buildProjectInstructions(["AGENTS.md"], [])).toThrow("absolute");
    expect(() => buildProjectInstructions([checkout], [])).toThrow("not a regular file");
    writeFileSync(join(checkout, "bad.md"), Buffer.from([0xff, 0xfe]));
    expect(() => buildProjectInstructions([join(checkout, "bad.md")], [])).toThrow("UTF-8");
    writeFileSync(join(checkout, "big.md"), "x".repeat(MAX_INSTRUCTIONS_BYTES + 1));
    expect(() => buildProjectInstructions([join(checkout, "big.md")], [])).toThrow("exceed");
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

describe("harness args", () => {
  test("Claude appends the instructions file to the system prompt, before the end of options", () => {
    const args = claudeArgs({ prompt: "p", model: "m", effort: "low", sessionId: "s", instructionsFile: "/state/i.md" });
    expect(after(args, "--append-system-prompt-file")).toBe("/state/i.md");
    expect(args.indexOf("--append-system-prompt-file")).toBeLessThan(args.indexOf("--"));
    expect(claudeArgs({ prompt: "p", model: "m", effort: "low", sessionId: "s" })).not.toContain("--append-system-prompt-file");
  });

  test("Codex always turns off its own AGENTS.md discovery, with or without instructions", () => {
    const none = codexArgs({ prompt: "p", model: "m", effort: "low", worktreePath: "/w" });
    expect(codexConfig(none, "project_doc_max_bytes")).toBe(0);
    expect(codexConfig(none, "developer_instructions")).toBeUndefined();
    const some = codexArgs({ prompt: "p", model: "m", effort: "low", worktreePath: "/w", instructions: "Use bun.\n" });
    expect(codexConfig(some, "project_doc_max_bytes")).toBe(0);
    expect(codexConfig(some, "developer_instructions")).toBe("Use bun.\n");
  });
});

describe("runAgent with project instructions", () => {
  test("both harnesses receive byte-identical instructions, and the run keeps the exact copy", async () => {
    writeFileSync(join(checkout, "AGENTS.md"), "The project codeword is PELICAN.\n");
    writeFileSync(join(checkout, "CLAUDE.md"), 'Quote "this" \\ and keep\nnewlines.\n');
    const files = projectInstructionFiles(checkout);
    const expected = buildProjectInstructions(files, [])!;

    const c = await runAgent(spec("claude", { instructionFiles: files }), sb.config);
    const claudeFile = after(argv(), "--append-system-prompt-file")!;
    expect(claudeFile).toBe(c.instructionsPath!);
    expect(readFileSync(claudeFile, "utf8")).toBe(expected);

    const x = await runAgent(spec("codex", { instructionFiles: files }), sb.config);
    expect(codexConfig(argv(), "developer_instructions")).toBe(expected);
    expect(readFileSync(x.instructionsPath!, "utf8")).toBe(expected);
  });

  test("no instruction files: no instructions passed and no instructions file", async () => {
    const c = await runAgent(spec("claude"), sb.config);
    expect(argv()).not.toContain("--append-system-prompt-file");
    expect(c.instructionsPath).toBeNull();
  });

  test("instruction files from the worktree are refused before anything starts", async () => {
    writeFileSync(join(sb.worktree, "AGENTS.md"), "planted by an earlier agent");
    const marker = join(sb.worktree, "started");
    await expect(runAgent(spec("codex", { prompt: `started:${marker}`, instructionFiles: [join(sb.worktree, "AGENTS.md")] }), sb.config)).rejects.toThrow("agent-writable");
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});
