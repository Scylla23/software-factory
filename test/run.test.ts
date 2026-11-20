import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, closeSync, cpSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, type RunSpec } from "../src/dispatch";
import { expandHome, MANDATORY_DENY_READ } from "../src/dispatch/policy";
import { type ProcRow, type Snapshot, scanWorktree, snapshot, spawnAgentProcess, superviseRun, sweepWorktree, terminateTree, verifyGone, Tracker } from "../src/dispatch/process";
import { alive, FIXTURES, fixture, gone, makeSandbox, readPid, type Sandbox, writeLines } from "./helpers";

let sb: Sandbox;
const saved = { HOME: process.env.HOME };
beforeEach(() => {
  sb = makeSandbox();
  cpSync(join(FIXTURES, "codex-sessions"), join(sb.codexHome, "sessions"), { recursive: true });
  const rollout = [...new Bun.Glob("sessions/*/*/*/*.jsonl").scanSync(sb.codexHome)][0]!;
  const file = join(sb.codexHome,rollout);
  const records = readFileSync(file,"utf8").trimEnd().split("\n").map(line=>JSON.parse(line));
  records[0].payload.base_instructions = {text: "Test instructions"};
  writeFileSync(file, records.map(row=>JSON.stringify(row)).join("\n")+"\n");
  appendFileSync(file,JSON.stringify({type:"response_item",payload:{type:"additional_tools",role:"developer",tools:[
    {type:"namespace",name:"functions",tools:[{name:"exec",description:"### `exec_command`"}]},
  ]}})+"\n");
  appendFileSync(file,JSON.stringify({type:"response_item",payload:{type:"message",role:"developer",content:[{type:"input_text",text:"Test instructions"}]}}) + "\n");
  process.env.HOME = sb.home; // the factory's inherited HOME; the agent's comes from config.accountHome
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  sb.cleanup();
});

function spec(harness: RunSpec["harness"], prompt: string, extra: Partial<RunSpec> = {}): RunSpec {
  return { harness, worktreePath: sb.worktree, prompt, model: "requested", effort: "low", logDir: sb.logDir, runId: crypto.randomUUID(), timeoutMs: 30_000, instructions: null, ...extra };
}

describe("runAgent", () => {
  test("successful model output is quarantined and metered if a new home source appeared", async () => {
    const result=await runAgent(spec("claude","home-change:"),sb.config);
    expect(result.outcome).toBe("failed");
    expect(result.quarantineWorktree).toBe(true);
    expect(result.usage?.harness).toBe("claude");
    expect(result.quarantineReasons).toContainEqual(expect.stringContaining("unexpected factory home location: CLAUDE.md"));
  });
  test("claude: completed run with observed model, usage, and clean diagnostics", async () => {
    const r = await runAgent(spec("claude", `replay:${fixture("claude-headless.stream.jsonl")}`), sb.config);
    expect(r).toMatchObject({ outcome: "completed", exitCode: 0, requestedModel: "requested", observedModel: "claude-haiku-5-5", resultText: "PELICAN", diagnostics: [], cleanup: null });
    expect(r.usage?.harness).toBe("claude");
    expect(r.promptRevision).toBe(createHash("sha256").update(JSON.stringify([`replay:${fixture("claude-headless.stream.jsonl")}`,null,null])).digest("hex"));
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
    for (const p of [...MANDATORY_DENY_READ.map((m) => expandHome(m, sb.home)), "/opt/secrets"]) expect(argv).toContain(JSON.stringify(p));
  });

  test.each(["claude", "codex"] as const)("%s: an alternate state root, its harness homes, and an inherited HOME elsewhere", async (harness) => {
    process.env.HOME = "/tmp/inherited-home";
    await runAgent(spec(harness, `dump:${sb.worktree}`), sb.config);
    const argv = readFileSync(join(sb.worktree, "argv"), "utf8");
    for (const p of [sb.stateRoot, ...Object.values(sb.config.harnessHomes)]) expect(argv).toContain(JSON.stringify(realpathSync(p)));
    expect(argv).toContain(JSON.stringify(join(sb.home, ".ssh")));
    expect(argv).not.toContain("/tmp/inherited-home");
    expect(readFileSync(join(sb.worktree, "env"), "utf8").split("\n")).toContain(`HOME=${sb.home}`);
  });

  test("refuses a log dir under a group-writable parent, and a state root that overlaps the worktree", async () => {
    const shared = join(sb.stateRoot, "shared");
    mkdirSync(join(shared, "logs"), { recursive: true });
    chmodSync(shared, 0o777);
    try {
      await expect(runAgent(spec("claude", "x", { logDir: join(shared, "logs") }), sb.config)).rejects.toThrow("group or world writable");
    } finally {
      chmodSync(shared, 0o755);
    }
    const inside = join(sb.stateRoot, "wt");
    mkdirSync(inside);
    await expect(runAgent(spec("claude", "x", { worktreePath: inside }), sb.config)).rejects.toThrow("overlaps agent-reachable");
  });

  test("the agent's PATH is the configured one; an absolute worktree dir in the parent PATH never reaches it", async () => {
    const path = process.env.PATH;
    process.env.PATH = `${join(sb.worktree, "node_modules", ".bin")}:${path}`;
    try {
      await runAgent(spec("codex", `dump:${sb.worktree}`), sb.config);
    } finally {
      process.env.PATH = path;
    }
    const env = readFileSync(join(sb.worktree, "env"), "utf8").split("\n");
    expect(env.filter((l) => l.startsWith("PATH="))).toEqual([`PATH=${sb.config.agentPath}`]);
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
    expect(r.sessionId).toBe(r.runId);
    expect(r.cleanup).toEqual({ survivors: [], errors: [] });
    expect(await gone(child)).toBe(true);
  });

  test("a child forked by the CLI's SIGTERM handler is killed too", async () => {
    const pidFile = join(sb.worktree, "late.pid");
    const ac = new AbortController();
    const pending = runAgent(spec("claude", `late:${pidFile}`, { signal: ac.signal }), sb.config);
    try {
      await readPid(`${pidFile}.ready`);
    } finally {
      ac.abort();
      await pending;
    }
    // The handler writes this before the CLI exits. A missing file is already a definitive failure.
    const late = Number(readFileSync(pidFile, "utf8").trim());
    expect(late).toBeGreaterThan(1);
    expect((await pending).outcome).toBe("cancelled");
    expect(await gone(late)).toBe(true);
  }, 30_000);

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

  test("a malformed thread id quarantines the attempt and retains usage", async () => {
    const lines = readFileSync(fixture("codex-headless.jsonl"), "utf8").trimEnd().split("\n");
    lines[0] = JSON.stringify({ type: "thread.started", thread_id: "../../etc/*" });
    const r = await runAgent(spec("codex", `replay:${writeLines(sb.worktree, "events.jsonl", lines)}`), sb.config);
    expect(r).toMatchObject({ outcome: "failed", quarantineWorktree: true, observedModel: null, usage: { inputTokens: 19356 } });
    expect(r.diagnostics).toContainEqual(expect.stringContaining("not a Codex thread id"));
  });

  test("a missing or unreadable rollout quarantines the attempt and retains usage", async () => {
    const day = join(sb.codexHome, "sessions", "2026", "11", "18");
    const rollout = join(day, "rollout-2026-11-18T22-52-33-01a1efae-7fd6-7ba1-a645-e89ed21cfbdb.jsonl");
    chmodSync(rollout, 0o000);
    try {
      const r = await runAgent(spec("codex", `replay:${fixture("codex-headless.jsonl")}`), sb.config);
      expect(r).toMatchObject({ outcome: "failed", quarantineWorktree: true, observedModel: null, usage: { inputTokens: 19356 } });
      expect(r.diagnostics).toContainEqual(expect.stringContaining("observed model unknown"));
    } finally {
      chmodSync(rollout, 0o644);
    }
    const lines = readFileSync(fixture("codex-headless.jsonl"), "utf8").trimEnd().split("\n");
    lines[0] = JSON.stringify({ type: "thread.started", thread_id: "00000000-0000-4000-8000-000000000000" });
    const r = await runAgent(spec("codex", `replay:${writeLines(sb.worktree, "events2.jsonl", lines)}`), sb.config);
    expect(r).toMatchObject({ outcome: "failed", quarantineWorktree: true, observedModel: null });
    expect(r.diagnostics).toContainEqual(expect.stringContaining("no rollout for thread"));
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

describe("bounded waits", () => {
  const spawnShell = (script: string) => {
    const o = openSync(join(sb.stateRoot, `${crypto.randomUUID()}.out`), "w");
    const p = spawnAgentProcess({ executable: "/bin/sh", args: ["-c", script], cwd: sb.worktree, env: { PATH: "/usr/bin:/bin" }, stdoutFd: o, stderrFd: o, psPath: "/bin/ps" });
    closeSync(o);
    return p;
  };
  const hangingPs = () => {
    const path = join(sb.bin, "hanging-ps");
    writeFileSync(path, "#!/bin/sh\nexec /bin/sleep 30\n");
    chmodSync(path, 0o755);
    return path;
  };

  test("a ps that never answers is killed and reported, not waited on", () => {
    const started = Date.now();
    expect(() => snapshot(hangingPs(), undefined, 200)).toThrow("no answer within 200ms");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("termination with a hanging ps still kills the root through its handle", async () => {
    const p = spawnShell("sleep 300");
    const report = await terminateTree(p, { psPath: hangingPs(), graceMs: 200, killWaitMs: 300, psTimeoutMs: 100 });
    expect((await p.exited).signal).not.toBeNull();
    expect(report.errors.some((e) => e.includes("no answer within 100ms"))).toBe(true);
  });

  test("a root whose exit is never observed cannot hang the run: supervision returns once termination gives up", async () => {
    const real = spawnShell("sleep 300");
    const neverExits = { ...real, exited: new Promise<never>(() => {}), exitedAt: () => null };
    const started = Date.now();
    const r = await superviseRun(neverExits, { timeoutMs: 50, psPath: "/bin/ps", graceMs: 100, killWaitMs: 200 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(r.status).toBeNull();
    expect(r.stopped).toBe("timed_out");
    expect(r.cleanup!.errors).toEqual([expect.stringContaining("did not exit")]);
    expect(r.unverified).toEqual([`root pid ${real.pid} never exited`]);
    expect((await real.exited).signal).not.toBeNull();
  });

  test("a termination that throws still settles supervision, as a quarantine reason", async () => {
    const real = spawnShell("sleep 300");
    const throwing = { ...real, exited: new Promise<never>(() => {}), exitedAt: () => null, kill: () => { throw new Error("EPERM signalling"); } };
    const r = await superviseRun(throwing, { timeoutMs: 20, psPath: "/bin/ps", graceMs: 50, killWaitMs: 50 });
    expect(r.stopped).toBe("timed_out");
    expect(r.cleanup!.errors).toEqual(["termination threw: EPERM signalling"]);
    expect(r.unverified).toEqual([`root pid ${real.pid} never exited`]);
    real.kill("SIGKILL");
    expect((await real.exited).signal).toBe("SIGKILL");
  });

  test("supervision of a root that exits by itself reports its status and no cleanup", async () => {
    const r = await superviseRun(spawnShell("exit 7"), { timeoutMs: 30_000, psPath: "/bin/ps" });
    expect(r).toEqual({ status: { code: 7, signal: null, error: null }, stopped: null, cleanup: null, unverified: [] });
  });

});

describe("cleanup verification", () => {
  const spawnShell = (script: string) => {
    const o = openSync(join(sb.stateRoot, `${crypto.randomUUID()}.out`), "w");
    const p = spawnAgentProcess({ executable: "/bin/sh", args: ["-c", script], cwd: sb.worktree, env: { PATH: "/usr/bin:/bin" }, stdoutFd: o, stderrFd: o, psPath: "/bin/ps" });
    closeSync(o);
    return p;
  };

  test("a clean run and a cleanly stopped run are verified, and the worktree is not quarantined", async () => {
    const done = await runAgent(spec("claude", `replay:${fixture("claude-headless.stream.jsonl")}`), sb.config);
    expect(done).toMatchObject({ outcome: "completed", noKnownSurvivors: true, quarantineWorktree: false, quarantineReasons: [] });
    const stopped = await runAgent({ ...spec("claude", `hang:${join(sb.worktree, "c.pid")}`), timeoutMs: 300 }, sb.config);
    expect(stopped).toMatchObject({ outcome: "timed_out", noKnownSurvivors: true, quarantineWorktree: false, quarantineReasons: [] });
  });

  test("a root that exits leaving a process in its group is unverified", async () => {
    const pidFile = join(sb.worktree, "left.pid");
    const r = await superviseRun(spawnShell(`sleep 300 & echo $! > "${pidFile}"; exit 0`), { timeoutMs: 30_000, psPath: "/bin/ps" });
    const left = await readPid(pidFile);
    try {
      expect(r.unverified).toEqual([`1 processes from the run's group outlived it: ${left}`]);
    } finally {
      process.kill(left, "SIGKILL");
    }
  });

  test("a stop whose termination could not enumerate processes is unverified, and runAgent quarantines the worktree", async () => {
    const psPath = join(sb.bin, "failing-ps");
    writeFileSync(psPath, "#!/bin/sh\nexit 2\n");
    chmodSync(psPath, 0o755);
    const r = await superviseRun(spawnShell("sleep 300"), { timeoutMs: 50, psPath, graceMs: 100, killWaitMs: 200 });
    expect(r.stopped).toBe("timed_out");
    expect(r.unverified.length).toBeGreaterThan(0);
    expect(r.unverified.every((u) => u.startsWith("termination: process snapshot failed"))).toBe(true);

    const config = { ...sb.config, executables: { ...sb.config.executables, ps: psPath } };
    const childFile = join(sb.worktree, "q.pid");
    // Stopped only once the child is running: a fixed short timeout could stop the fake before it starts the child,
    // and the pid this test reads would then never be written.
    const ac = new AbortController();
    const pending = runAgent({ ...spec("claude", `hang:${childFile}`), signal: ac.signal }, config);
    try {
      await readPid(childFile);
      ac.abort();
      const run = await pending;
      expect(run).toMatchObject({ outcome: "cancelled", noKnownSurvivors: false, quarantineWorktree: true });
      expect(run.diagnostics).toContainEqual(expect.stringMatching(/^quarantine: termination: process snapshot failed/));
      // The flag is truthful: without ps the fake's background child was never found, so it is still alive.
      expect(alive(await readPid(childFile))).toBe(true);
    } finally {
      // The run is settled inside the test, and the child killed only if it was ever started.
      ac.abort();
      await pending.catch(() => undefined);
      const pid = Number(readFileSync(childFile, { encoding: "utf8", flag: "a+" }).trim());
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});

test("verifyGone: survivors of termination make cleanup unverified", () => {
  const exited = { code: null, signal: "SIGKILL", error: null };
  const survivor = { pid: 4242, start: "Thu Nov 19 00:00:00 2026" };
  const root = { pid: 4241, exitedAt: () => 1 } as Parameters<typeof verifyGone>[0];
  expect(verifyGone(root, exited, { survivors: [survivor], errors: [] }, { psPath: "/bin/ps" })).toEqual(["1 owned processes survived termination: 4242"]);
  expect(verifyGone(root, exited, { survivors: [], errors: [] }, { psPath: "/bin/ps" })).toEqual([]);
  expect(verifyGone(root, { code: null, signal: null, error: "ENOENT" }, null, { psPath: "/nonexistent" })).toEqual([]);
});

describe("worktree sweep", () => {
  test("a detached child left in the worktree after the CLI exits is found, killed, and quarantines the worktree", async () => {
    const pidFile = join(sb.stateRoot, "detached.pid");
    const r = await runAgent(spec("claude", `detach:${pidFile}`), sb.config);
    const pid = await readPid(pidFile);
    try {
      expect(r.outcome).toBe("completed");
      expect(r).toMatchObject({ noKnownSurvivors: true, quarantineWorktree: true });
      expect(r.quarantineReasons).toEqual([`1 processes were still running in the worktree after the run: ${pid}`]);
      expect(await gone(pid)).toBe(true);
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  test("the detached child really is outside the run's group and reparented, which supervision alone cannot see", async () => {
    const pidFile = join(sb.stateRoot, "detached.pid");
    const o = openSync(join(sb.stateRoot, "out"), "w");
    const root = spawnAgentProcess({ executable: sb.config.executables.claude, args: [`detach:${pidFile}`], cwd: sb.worktree, env: { PATH: "/usr/bin:/bin" }, stdoutFd: o, stderrFd: o, psPath: "/bin/ps" });
    closeSync(o);
    const supervised = await superviseRun(root, { timeoutMs: 30_000, psPath: "/bin/ps" });
    const pid = await readPid(pidFile);
    try {
      const row = snapshot("/bin/ps", [pid]).get(pid)!;
      expect(row.ppid).toBe(1);
      expect(row.pgid).not.toBe(root.pid);
      expect(supervised.unverified).toEqual([]);
      expect(scanWorktree(realpathSync(sb.worktree), { psPath: "/bin/ps", lsofPath: "/usr/sbin/lsof" })).toEqual([{ pid, start: row.start }]);
    } finally {
      process.kill(pid, "SIGKILL");
    }
  });

  test("a detached process in a subdirectory of the worktree is found too", async () => {
    const sub = join(sb.worktree, "deep", "er");
    mkdirSync(sub, { recursive: true });
    const pidFile = join(sb.stateRoot, "sub.pid");
    Bun.spawnSync(["/usr/bin/perl", "-MPOSIX", "-e", 'exit 0 if fork; POSIX::setsid(); exit 0 if fork; open(my $f, ">", $ARGV[0]); print $f $$; close $f; exec "/bin/sleep", "306"', pidFile], { cwd: sub });
    const pid = await readPid(pidFile);
    try {
      expect(scanWorktree(realpathSync(sb.worktree), { psPath: "/bin/ps", lsofPath: "/usr/sbin/lsof" }).map((p) => p.pid)).toEqual([pid]);
    } finally {
      process.kill(pid, "SIGKILL");
    }
  });

  test("a process in the worktree under a live parent outside it (an Orca terminal shell) is not the run's", async () => {
    const pidFile = join(sb.stateRoot, "shell-child.pid");
    const o = openSync(join(sb.stateRoot, "out"), "w");
    const shell = spawn("/bin/sh", ["-c", `(cd '${sb.worktree}' && exec /bin/sleep 305) & echo $! > '${pidFile}'; wait`], { cwd: sb.stateRoot, stdio: ["ignore", o, o] });
    closeSync(o);
    const pid = await readPid(pidFile);
    try {
      for (let i = 0; i < 100 && !Bun.spawnSync(["/usr/sbin/lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]).stdout.toString().includes(realpathSync(sb.worktree)); i++) await Bun.sleep(20);
      expect(scanWorktree(realpathSync(sb.worktree), { psPath: "/bin/ps", lsofPath: "/usr/sbin/lsof" })).toEqual([]);
    } finally {
      process.kill(pid, "SIGKILL");
      shell.kill("SIGKILL");
    }
  });

  test("a failing or hanging scan quarantines the worktree", async () => {
    const failing = join(sb.bin, "failing-lsof");
    writeFileSync(failing, "#!/bin/sh\necho broken >&2\nexit 1\n");
    chmodSync(failing, 0o755);
    const config = { ...sb.config, executables: { ...sb.config.executables, lsof: failing } };
    const r = await runAgent(spec("claude", `replay:${fixture("claude-headless.stream.jsonl")}`), config);
    expect(r).toMatchObject({ outcome: "completed", noKnownSurvivors: false, quarantineWorktree: true, quarantineReasons: ["worktree scan failed: lsof exited 1: broken"] });

    const hanging = join(sb.bin, "hanging-lsof");
    writeFileSync(hanging, "#!/bin/sh\nexec /bin/sleep 30\n");
    chmodSync(hanging, 0o755);
    const started = Date.now();
    expect(await sweepWorktree(sb.worktree, { psPath: "/bin/ps", lsofPath: hanging, lsofTimeoutMs: 200 })).toEqual({ found: [], cleanup: null, scanError: "lsof gave no answer within 200ms" });
    expect(Date.now() - started).toBeLessThan(2_000);
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
