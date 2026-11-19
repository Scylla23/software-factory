import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { runAgent, type RunSpec } from "../src/dispatch";
import { orcaJson } from "../src/orca/cli";
import { monitorCommand, openRunMonitor, shellQuote } from "../src/orca/monitor";
import { fixture, makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const setMode = (mode: "ok" | "fail" | "hang" | "hang-create" | "ok-exit") => writeFileSync(join(sb.bin, "orca-mode"), mode);
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
    effort: "low", logDir: sb.logDir, runId: crypto.randomUUID(), timeoutMs: 30_000, instructions: null, ...extra,
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
  /**
   * Types the command into an interactive shell, as the tab does, with another command queued after it, then presses
   * Ctrl-C (SIGINT to the foreground process group). An interactive shell survives SIGINT, so if the viewer did not
   * replace it, the queued command would run. Bounded, and the whole group is killed afterwards.
   */
  async function typedIntoShell(log: string) {
    const sh = spawn("/bin/sh", ["-i"], { detached: true, stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", PS1: "" } });
    let out = "";
    sh.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    const exited = new Promise<string | null>((resolve) => sh.once("exit", (_code, signal) => resolve(signal)));
    try {
      sh.stdin!.write(`${monitorCommand("factory: builder x", log)}\necho BACK-IN-OWNER-SHELL\n`);
      for (let i = 0; i < 250 && !out.includes("first line\n"); i++) await Bun.sleep(20);
      const comm = Bun.spawnSync(["/bin/ps", "-o", "comm=", "-p", String(sh.pid)]).stdout.toString().trim();
      const stdin = Bun.spawnSync(["/usr/sbin/lsof", "-a", "-p", String(sh.pid), "-d", "0", "-Fn"]).stdout.toString();
      process.kill(-sh.pid!, "SIGINT");
      const signal = await Promise.race([exited, Bun.sleep(2_000).then(() => "still running")]);
      await Bun.sleep(100); // let a queued echo, if any, reach stdout
      return { out, comm, stdin, signal };
    } finally {
      try {
        process.kill(-sh.pid!, "SIGKILL");
      } catch {
        // the group is already gone
      }
      // A viewer the shell put in a job of its own (a regression) is outside that group; the log path is unique.
      Bun.spawnSync(["/usr/bin/pkill", "-KILL", "-f", `tail -n \\+1 -f -- ${log}`]);
    }
  }

  test("sets the live title, then the shell becomes /usr/bin/tail on the log, reading no input", async () => {
    const log = join(sb.logDir, "it's a log.jsonl");
    writeFileSync(log, "first line\n");
    const r = await typedIntoShell(log);
    expect(r.out.startsWith("\x1b]0;factory: builder x\x07first line\n")).toBe(true);
    expect(r.comm).toBe("/usr/bin/tail");
    expect(r.stdin).toContain("n/dev/null");
  });

  test("interrupting the viewer ends the tab instead of returning to the owner's shell", async () => {
    const log = join(sb.logDir, "run.jsonl");
    writeFileSync(log, "first line\n");
    const r = await typedIntoShell(log);
    expect(r.signal).toBe("SIGINT");
    expect(r.out).not.toContain("BACK-IN-OWNER-SHELL");
  });

  test("refuses titles and log paths a terminal or shell would interpret", () => {
    for (const title of ["", "a\x1b]0;x", "a'b", "a  b", "$(id)", "a\nb", "x".repeat(129)]) {
      expect(() => monitorCommand(title, "/l")).toThrow("plain words");
    }
    expect(() => monitorCommand("t", "relative.jsonl")).toThrow("absolute");
    expect(() => monitorCommand("t", "/l\x07")).toThrow("control characters");
  });

  test("openRunMonitor validates the title itself, before calling orca", () => {
    expect(() => openRunMonitor({ orcaPath: sb.config.executables.orca, worktreePath: sb.worktree, title: "bad\x07title", attemptId: ATTEMPT, logPath: "/l" })).toThrow("plain words");
    expect(() => openRunMonitor({ orcaPath: sb.config.executables.orca, worktreePath: sb.worktree, title: "factory: x", attemptId: ATTEMPT, logPath: "/l" })).toThrow("attempt id");
    expect(calls()).toEqual([]);
  });
});

const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const monitor = (extra: { openTimeoutMs?: number; cleanupTimeoutMs?: number } = {}) =>
  openRunMonitor({ orcaPath: sb.config.executables.orca, worktreePath: sb.worktree, title: `factory: builder ${ATTEMPT}`, attemptId: ATTEMPT, logPath: "/l", ...extra });

describe("run monitor", () => {
  test("opens a titled tab tailing the run log in the run's worktree, then closes it when the run ends", async () => {
    const s = spec({ monitor: { agent: "builder" } });
    const r = await runAgent(s, sb.config);
    expect(r).toMatchObject({ outcome: "completed", diagnostics: [] });
    const [create, close] = calls();
    expect(create).toEqual([
      "terminal", "create", "--worktree", `path:${realpathSync(sb.worktree)}`, "--title", `factory: builder ${s.runId}`,
      "--command", monitorCommand(`factory: builder ${s.runId}`, r.stdoutPath), "--json",
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
    const problems = await monitor({ openTimeoutMs: 300, cleanupTimeoutMs: 300 }).close();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(problems).toEqual([expect.stringContaining("no answer within 300ms"), expect.stringMatching(/^reconcile failed: .*no answer within 300ms/)]);
  });

  test("a nonzero exit is a failure even with an ok envelope", async () => {
    setMode("ok-exit");
    await expect(orcaJson(sb.config.executables.orca, ["worktree", "rm"])).rejects.toThrow("exit 3 despite an ok envelope");
    const problems = await monitor().close();
    expect(problems[0]).toMatch(/^open failed: .*exit 3 despite an ok envelope/);
    expect(calls().map((c) => c.slice(0, 2).join(" "))).toEqual(["worktree rm", "terminal create", "terminal list"]);
  });

  test("a create that times out is reconciled: every tab titled with this attempt is closed, and only those", async () => {
    setMode("hang-create");
    writeFileSync(join(sb.bin, "orca-list"), JSON.stringify({ ok: true, result: { truncated: false, terminals: [
      { handle: "term_title", title: `factory: builder ${ATTEMPT}`, paneTitle: "zsh" },
      { handle: "term_pane", title: "tail", paneTitle: `factory: builder ${ATTEMPT}` },
      { handle: "term_other", title: `factory: builder ${crypto.randomUUID()}` },
      { handle: "term_owner", title: "zsh" },
    ] } }));
    const problems = await monitor({ openTimeoutMs: 300 }).close();
    const closed = calls().filter((c) => c[1] === "close").map((c) => c[3]);
    expect(closed).toEqual(["term_title", "term_pane"]);
    expect(problems).toEqual([
      expect.stringContaining("no answer within 300ms"),
      "reconcile: closed term_title, opened by the failed create",
      "reconcile: closed term_pane, opened by the failed create",
    ]);
  });

  test("the reconcile after a timed-out create is not bounded by the create's timeout", async () => {
    setMode("hang-create");
    writeFileSync(join(sb.bin, "orca-delay"), "0.6");
    writeFileSync(join(sb.bin, "orca-list"), JSON.stringify({ ok: true, result: { terminals: [{ handle: "term_title", title: `factory: builder ${ATTEMPT}` }] } }));
    const problems = await monitor({ openTimeoutMs: 300 }).close();
    expect(problems).toEqual([expect.stringContaining("no answer within 300ms"), "reconcile: closed term_title, opened by the failed create"]);
  });

  test("a clean ok:false refusal needs no reconciliation", async () => {
    setMode("fail");
    await monitor().close();
    expect(calls().map((c) => c.slice(0, 2).join(" "))).toEqual(["terminal create"]);
  });

  test("a bad agent label is refused before anything starts", async () => {
    await expect(runAgent(spec({ monitor: { agent: "x; rm -rf ~" } }), sb.config)).rejects.toThrow("monitor agent label");
    expect(calls()).toEqual([]);
  });
});
