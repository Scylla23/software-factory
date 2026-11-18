import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, cpSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, type RunSpec } from "../src/dispatch";
import { MANDATORY_DENY_READ } from "../src/dispatch/policy";
import { type ProcRow, type Snapshot, spawnAgentProcess, terminateTree, Tracker } from "../src/dispatch/process";
import { alive, FIXTURES, fixture, gone, makeSandbox, readPid, type Sandbox, writeLines } from "./helpers";

let sb: Sandbox;
const saved = { HOME: process.env.HOME };
beforeEach(() => {
  sb = makeSandbox();
  cpSync(join(FIXTURES, "codex-sessions"), join(sb.codexHome, "sessions"), { recursive: true });
  process.env.HOME = sb.home; // the agent's HOME
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  sb.cleanup();
});

function spec(harness: RunSpec["harness"], prompt: string, extra: Partial<RunSpec> = {}): RunSpec {
  return { harness, worktreePath: sb.worktree, prompt, model: "requested", effort: "low", logDir: sb.logDir, runId: crypto.randomUUID(), timeoutMs: 30_000, ...extra };
}

describe("runAgent", () => {
  test("claude: completed run with observed model, usage, and clean diagnostics", async () => {
    const r = await runAgent(spec("claude", `replay:${fixture("claude-headless.stream.jsonl")}`), sb.config);
    expect(r).toMatchObject({ outcome: "completed", exitCode: 0, requestedModel: "requested", observedModel: "claude-haiku-5-5", resultText: "PELICAN", diagnostics: [], cleanup: null });
    expect(r.usage?.harness).toBe("claude");
  });

  test("codex: observed model comes from the session file under the dedicated CODEX_HOME", async () => {
    const r = await runAgent(spec("codex", `replay:${fixture("codex-headless.jsonl")}`), sb.config);
    expect(r).toMatchObject({ outcome: "completed", sessionId: "01a1efae-7fd6-7ba1-a645-e89ed21cfbdb", observedModel: "gpt-6-luna", diagnostics: [] });
  });

  test("a successful exit without a result event is a failure", async () => {
    const r = await runAgent(spec("codex", `replay:${fixture("codex-cancelled.jsonl")}`), sb.config);
    expect(r).toMatchObject({ outcome: "failed", exitCode: 0, usage: null });
  });

  test("the agent process never sees parent secrets", async () => {
    process.env.FACTORY_CANARY = "CANARY-test";
    try {
      await runAgent(spec("claude", `dump:${sb.worktree}`), sb.config);
      const env = readFileSync(join(sb.worktree, "env"), "utf8");
      expect(env).not.toContain("CANARY-test");
      expect(env).toContain(`HOME=${sb.home}`);
    } finally {
      delete process.env.FACTORY_CANARY;
    }
  });

  test.each([
    ["claude", "CLAUDE_CONFIG_DIR", "CODEX_HOME"],
    ["codex", "CODEX_HOME", "CLAUDE_CONFIG_DIR"],
  ] as const)("%s runs with its dedicated home, whatever the parent's", async (harness, own, other) => {
    process.env.CODEX_HOME = "/owner/.codex";
    process.env.CLAUDE_CONFIG_DIR = "/owner/.claude";
    try {
      await runAgent(spec(harness, `dump:${sb.worktree}`), sb.config);
      const env = readFileSync(join(sb.worktree, "env"), "utf8").split("\n");
      expect(env).toContain(`${own}=${sb.config.harnessHomes[harness]}`);
      expect(env.some((l) => l.startsWith(`${other}=`))).toBe(false);
    } finally {
      delete process.env.CODEX_HOME;
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  test("refuses a harness home that other users can read, before anything starts", async () => {
    chmodSync(sb.config.harnessHomes.codex, 0o755);
    const marker = join(sb.worktree, "started");
    await expect(runAgent(spec("codex", `started:${marker}`), sb.config)).rejects.toThrow("accessible to group or others");
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test.each(["claude", "codex"] as const)("%s: an extra deny path is added to the mandatory list in the real argv", async (harness) => {
    await runAgent(spec(harness, `dump:${sb.worktree}`, { extraDenyRead: ["/opt/secrets"] }), sb.config);
    const argv = readFileSync(join(sb.worktree, "argv"), "utf8");
    for (const p of [...MANDATORY_DENY_READ, "/opt/secrets"]) expect(argv).toContain(JSON.stringify(p));
  });

  test("executables come only from the config, never from PATH", async () => {
    const evil = join(sb.worktree, "evil-bin");
    const marker = join(sb.worktree, "evil-ran");
    mkdirSync(evil);
    for (const name of ["claude", "codex", "ps"]) {
      writeFileSync(join(evil, name), `#!/bin/sh\n: > "${marker}"\n`);
      chmodSync(join(evil, name), 0o755);
    }
    const path = process.env.PATH;
    process.env.PATH = `${evil}:${path}`;
    try {
      const pidFile = join(sb.worktree, "p.pid");
      const r = await runAgent(spec("claude", `hang:${pidFile}`, { timeoutMs: 300 }), sb.config);
      expect(r.outcome).toBe("timed_out");
    } finally {
      process.env.PATH = path;
    }
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("refuses an executable that lives inside the worktree", async () => {
    const inside = join(sb.worktree, "claude");
    writeFileSync(inside, "#!/bin/sh\n");
    chmodSync(inside, 0o755);
    const config = { ...sb.config, executables: { ...sb.config.executables, claude: inside } };
    await expect(runAgent(spec("claude", "x"), config)).rejects.toThrow("inside the worktree");
  });

  test("an already-aborted signal throws before anything starts", async () => {
    const marker = join(sb.worktree, "started");
    const ac = new AbortController();
    ac.abort();
    await expect(runAgent(spec("claude", `started:${marker}`, { signal: ac.signal }), sb.config)).rejects.toThrow();
    await Bun.sleep(100);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("a missing executable is a failed run with a diagnostic, not a crash", async () => {
    const config = { ...sb.config, executables: { ...sb.config.executables, codex: join(sb.stateRoot, "missing-codex") } };
    const r = await runAgent(spec("codex", "x"), config);
    expect(r.outcome).toBe("failed");
    expect(r.diagnostics).toEqual(expect.arrayContaining([expect.stringContaining("spawn failed")]));
  });

  test("abort kills the CLI and its orphan-prone children", async () => {
    const pidFile = join(sb.worktree, "child.pid");
    const ac = new AbortController();
    const pending = runAgent(spec("claude", `hang:${pidFile}`, { signal: ac.signal }), sb.config);
    const child = await readPid(pidFile);
    expect(alive(child)).toBe(true);
    ac.abort();
    const r = await pending;
    expect(r.outcome).toBe("cancelled");
    expect(r.sessionId).toBe("s");
    expect(r.cleanup).toEqual({ survivors: [], errors: [] });
    expect(await gone(child)).toBe(true);
  });

  test("a child forked by the CLI's SIGTERM handler is killed too", async () => {
    const pidFile = join(sb.worktree, "late.pid");
    const ac = new AbortController();
    const pending = runAgent(spec("claude", `late:${pidFile}`, { signal: ac.signal }), sb.config);
    await Bun.sleep(300); // let the fake install its trap
    ac.abort();
    const r = await pending;
    const late = await readPid(pidFile);
    expect(r.outcome).toBe("cancelled");
    expect(await gone(late)).toBe(true);
  });

  test("a child already reparented to launchd before cancellation is killed through the process group", async () => {
    const pidFile = join(sb.worktree, "orphan.pid");
    const ac = new AbortController();
    const pending = runAgent(spec("claude", `orphan:${pidFile}`, { signal: ac.signal }), sb.config);
    const orphan = await readPid(pidFile);
    const ps = Bun.spawnSync(["/bin/ps", "-o", "ppid=", "-p", String(orphan)], { stdout: "pipe" });
    expect(ps.stdout.toString().trim()).toBe("1");
    ac.abort();
    await pending;
    expect(await gone(orphan)).toBe(true);
  });

  test("timeout stops the run and is reported as timed_out", async () => {
    const r = await runAgent(spec("claude", `hang:${join(sb.worktree, "c.pid")}`, { timeoutMs: 200 }), sb.config);
    expect(r.outcome).toBe("timed_out");
    expect(r.usage).toBeNull();
  });

  test("a malformed thread id keeps the outcome and usage; only the observed model is unknown", async () => {
    const lines = readFileSync(fixture("codex-headless.jsonl"), "utf8").trimEnd().split("\n");
    lines[0] = JSON.stringify({ type: "thread.started", thread_id: "../../etc/*" });
    const r = await runAgent(spec("codex", `replay:${writeLines(sb.worktree, "events.jsonl", lines)}`), sb.config);
    expect(r).toMatchObject({ outcome: "completed", observedModel: null, usage: { inputTokens: 19356 } });
    expect(r.diagnostics).toEqual([expect.stringContaining("not a Codex thread id")]);
  });

  test("a missing or unreadable rollout keeps the outcome and usage; only the observed model is unknown", async () => {
    const day = join(sb.codexHome, "sessions", "2026", "11", "18");
    const rollout = join(day, "rollout-2026-11-18T22-52-33-01a1efae-7fd6-7ba1-a645-e89ed21cfbdb.jsonl");
    chmodSync(rollout, 0o000);
    try {
      const r = await runAgent(spec("codex", `replay:${fixture("codex-headless.jsonl")}`), sb.config);
      expect(r).toMatchObject({ outcome: "completed", observedModel: null, usage: { inputTokens: 19356 } });
      expect(r.diagnostics).toEqual([expect.stringContaining("observed model unknown")]);
    } finally {
      chmodSync(rollout, 0o644);
    }
    const lines = readFileSync(fixture("codex-headless.jsonl"), "utf8").trimEnd().split("\n");
    lines[0] = JSON.stringify({ type: "thread.started", thread_id: "00000000-0000-4000-8000-000000000000" });
    const r = await runAgent(spec("codex", `replay:${writeLines(sb.worktree, "events2.jsonl", lines)}`), sb.config);
    expect(r).toMatchObject({ outcome: "completed", observedModel: null });
    expect(r.diagnostics).toEqual([expect.stringContaining("no rollout for thread")]);
  });

  test("present, unaccepted managed settings refuse a Claude dispatch before it starts", async () => {
    writeFileSync(sb.config.managedSettingsPaths[0]!, "{}");
    const marker = join(sb.worktree, "started");
    await expect(runAgent(spec("claude", `started:${marker}`), sb.config)).rejects.toThrow("managed settings");
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("rejects a reused attempt id and a log dir outside the state root", async () => {
    const s = spec("claude", `replay:${fixture("claude-headless.stream.jsonl")}`);
    await runAgent(s, sb.config);
    await expect(runAgent(s, sb.config)).rejects.toThrow("single-use");
    await expect(runAgent(spec("claude", "x", { logDir: sb.worktree }), sb.config)).rejects.toThrow("not under the state root");
  });

  test("rejects a runId that is not a UUID", async () => {
    await expect(runAgent(spec("claude", "x", { runId: "../../etc" }), sb.config)).rejects.toThrow("runId must be a lowercase UUID");
  });
});

describe("terminateTree", () => {
  const spawnShell = (script: string, psPath = "/bin/ps") => {
    const o = openSync(join(sb.stateRoot, `${crypto.randomUUID()}.out`), "w");
    const p = spawnAgentProcess({ executable: "/bin/sh", args: ["-c", script], cwd: sb.worktree, env: { PATH: "/usr/bin:/bin" }, stdoutFd: o, stderrFd: o, psPath });
    closeSync(o);
    return p;
  };

  test("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
    const pidFile = join(sb.worktree, "stubborn.pid");
    const p = spawnShell(`(trap '' TERM; sleep 300) & echo $! > "${pidFile}"; wait`);
    const child = await readPid(pidFile);
    await Bun.sleep(100); // let the subshell install its trap
    const report = await terminateTree(p, { psPath: "/bin/ps", graceMs: 200 });
    expect(report).toEqual({ survivors: [], errors: [] });
    expect(await gone(child)).toBe(true);
  });

  test("when process enumeration fails, the root is still terminated through its handle and the failure is reported", async () => {
    const p = spawnShell("sleep 300", "/nonexistent/ps");
    expect(p.identity).toBeNull();
    const report = await terminateTree(p, { psPath: "/nonexistent/ps", graceMs: 200, killWaitMs: 500 });
    const status = await p.exited;
    expect(status.signal).not.toBeNull();
    expect(report.errors.some((e) => e.includes("process snapshot failed"))).toBe(true);
  });
});

describe("Tracker identity", () => {
  const row = (pid: number, ppid: number, start: string, pgid = pid): ProcRow => ({ pid, ppid, pgid, start, zombie: false });
  const root = { pid: 100, identity: { pid: 100, start: "Wed Nov 18 10:00:00 2026" }, exitedAt: () => Date.parse("2026-11-18T10:05:00Z") };

  test("a pid whose start time changed is a different process: never signalled, its children never adopted", () => {
    const t = new Tracker(root);
    const first: Snapshot = new Map([
      [100, row(100, 1, "Wed Nov 18 10:00:00 2026")],
      [200, row(200, 100, "Wed Nov 18 10:01:00 2026", 200)],
    ]);
    t.expand(first);
    expect(t.verified(first).map((p) => p.pid)).toEqual([200]);
    // pid 200 exits and is recycled by an unrelated process with its own child.
    const later: Snapshot = new Map([
      [200, row(200, 1, "Wed Nov 18 10:09:00 2026", 200)],
      [300, row(300, 200, "Wed Nov 18 10:09:30 2026", 300)],
    ]);
    t.expand(later);
    expect(t.verified(later)).toEqual([]);
  });

  test("start times compare in UTC whatever the factory's time zone", () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const t = new Tracker(root);
      const snap: Snapshot = new Map([[400, row(400, 1, "Wed Nov 18 10:04:00 2026", 100)]]);
      t.expand(snap);
      expect(t.verified(snap).map((p) => p.pid)).toEqual([400]);
    } finally {
      process.env.TZ = tz;
    }
  });

  test("a group member that started after the root exited is not ours (recycled group id)", () => {
    const t = new Tracker(root);
    const snap: Snapshot = new Map([
      [400, row(400, 1, "Wed Nov 18 10:04:00 2026", 100)],
      [500, row(500, 1, "Wed Nov 18 10:30:00 2026", 100)],
    ]);
    t.expand(snap);
    expect(t.verified(snap).map((p) => p.pid)).toEqual([400]);
  });
});
