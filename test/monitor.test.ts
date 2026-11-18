import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, type RunSpec } from "../src/dispatch";
import { monitorCommand, openRunMonitor, shellQuote } from "../src/orca/monitor";
import { fixture, makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const setMode = (mode: "ok" | "fail" | "hang") => writeFileSync(join(sb.bin, "orca-mode"), mode);
/** Each recorded orca call as its argv. */
const calls = (): string[][] => {
  let text = "";
  try {
    text = readFileSync(join(sb.bin, "orca-calls"), "utf8");
  } catch {
    return [];
  }
  return text.split("--\n").filter(Boolean).map((c) => c.trimEnd().split("\n"));
};

function spec(extra: Partial<RunSpec> = {}): RunSpec {
  return {
    harness: "claude", worktreePath: sb.worktree, prompt: `replay:${fixture("claude-headless.stream.jsonl")}`, model: "requested",
    effort: "low", logDir: sb.logDir, runId: crypto.randomUUID(), timeoutMs: 30_000, instructionFiles: [], ...extra,
  };
}

describe("shellQuote", () => {
  test("survives quotes, spaces, and shell syntax", async () => {
    const nasty = `/a b/it's $(x) \`y\` "z"`;
    const out = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${shellQuote(nasty)}`]).stdout.toString();
    expect(out).toBe(nasty);
  });
});

describe("monitorCommand", () => {
  test("sets the live title with an OSC 0 escape, then tails the log from its first line", () => {
    // A shell function stands in for tail, which would never exit; it prints the arguments it got.
    const script = `tail() { printf '[%s]' "$@"; }; ${monitorCommand("factory: builder x", "/state/it's.jsonl")}`;
    const out = Bun.spawnSync(["/bin/sh", "-c", script]).stdout.toString();
    expect(out).toBe("\x1b]0;factory: builder x\x07[-n][+1][-f][/state/it's.jsonl]");
  });
});

describe("run monitor", () => {
  test("opens a titled tab tailing the run log in the run's worktree, then closes it when the run ends", async () => {
    const s = spec({ monitor: { agent: "builder" } });
    const r = await runAgent(s, sb.config);
    expect(r).toMatchObject({ outcome: "completed", diagnostics: [] });
    const [create, close] = calls();
    expect(create).toEqual([
      "terminal", "create", "--worktree", `path:${realpathSync(sb.worktree)}`, "--title", `factory: builder ${s.runId}`,
      "--command", `printf '\\033]0;%s\\007' 'factory: builder ${s.runId}'; tail -n +1 -f '${r.stdoutPath}'`, "--json",
    ]);
    expect(close).toEqual(["terminal", "close", "--terminal", "term_fake", "--json"]);
    expect(calls()).toHaveLength(2);
  });

  test("no monitor unless asked", async () => {
    await runAgent(spec(), sb.config);
    expect(calls()).toEqual([]);
  });

  test("a failing orca leaves the run's outcome, usage, and result untouched", async () => {
    setMode("fail");
    const plain = await runAgent(spec(), sb.config);
    const r = await runAgent(spec({ monitor: { agent: "builder" } }), sb.config);
    expect(r).toMatchObject({ outcome: plain.outcome, exitCode: plain.exitCode, usage: plain.usage, resultText: plain.resultText });
    expect(r.diagnostics).toEqual([expect.stringMatching(/^monitor: open failed: orca terminal create failed/)]);
  });

  test("a missing orca executable is only a diagnostic", async () => {
    const config = { ...sb.config, executables: { ...sb.config.executables, orca: join(sb.bin, "no-such-orca") } };
    const r = await runAgent(spec({ monitor: { agent: "builder" } }), config);
    expect(r.outcome).toBe("completed");
    expect(r.diagnostics).toEqual([expect.stringMatching(/^monitor: open failed/)]);
  });

  test("a hung orca is bounded and only reported", async () => {
    setMode("hang");
    const started = Date.now();
    const problems = await openRunMonitor({ orcaPath: sb.config.executables.orca, worktreePath: sb.worktree, title: "t", logPath: "/l", timeoutMs: 300 }).close();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(problems).toEqual([expect.stringContaining("no answer within 300ms")]);
  });

  test("a bad agent label is refused before anything starts", async () => {
    await expect(runAgent(spec({ monitor: { agent: "x; rm -rf ~" } }), sb.config)).rejects.toThrow("monitor agent label");
    expect(calls()).toEqual([]);
  });
});
