import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, type RunSpec } from "../src/dispatch";
import { terminateTree } from "../src/dispatch/process";

// Fake `claude` and `codex` on PATH. The env is stripped, so the fake reads its instruction from the prompt (last argv).
const FAKE_CLI = `#!/bin/sh
for last; do :; done
case "$last" in
  replay:*) cat "\${last#replay:}" ;;
  env:*) env > "\${last#env:}"; cat "${join(import.meta.dir, "fixtures", "claude-headless.stream.jsonl")}" ;;
  hang:*)
    echo '{"type":"system","subtype":"init","session_id":"s","model":"m"}'
    sleep 300 &
    echo $! > "\${last#hang:}"
    wait ;;
esac
`;

let dir: string;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dispatch-test-"));
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(dir, name), FAKE_CLI);
    chmodSync(join(dir, name), 0o755);
  }
  cpSync(join(import.meta.dir, "fixtures", "codex-sessions"), join(dir, "home", ".codex", "sessions"), { recursive: true });
  process.env.PATH = `${dir}:${saved.PATH}`;
  process.env.HOME = join(dir, "home");
});

afterAll(() => {
  process.env.PATH = saved.PATH;
  process.env.HOME = saved.HOME;
  rmSync(dir, { recursive: true, force: true });
});

const fixture = (name: string) => join(import.meta.dir, "fixtures", name);

function spec(harness: RunSpec["harness"], prompt: string, extra: Partial<RunSpec> = {}): RunSpec {
  return { harness, worktreePath: dir, prompt, model: "requested", effort: "low", logDir: dir, runId: crypto.randomUUID(), timeoutMs: 30_000, ...extra };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A killed orphan stays a zombie until launchd reaps it, so poll briefly. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(20);
  return !alive(pid);
}

describe("runAgent", () => {
  test("claude: completed run with observed model and usage", async () => {
    const r = await runAgent(spec("claude", `replay:${fixture("claude-headless.stream.jsonl")}`));
    expect(r).toMatchObject({ outcome: "completed", exitCode: 0, requestedModel: "requested", observedModel: "claude-haiku-5-5", resultText: "PELICAN" });
    expect(r.usage?.harness).toBe("claude");
  });

  test("codex: observed model comes from the session file under the agent's HOME", async () => {
    const r = await runAgent(spec("codex", `replay:${fixture("codex-headless.jsonl")}`));
    expect(r).toMatchObject({ outcome: "completed", sessionId: "01a1efae-7fd6-7ba1-a645-e89ed21cfbdb", observedModel: "gpt-6-luna" });
  });

  test("a successful exit without a result event is a failure", async () => {
    const r = await runAgent(spec("codex", `replay:${fixture("codex-cancelled.jsonl")}`));
    expect(r).toMatchObject({ outcome: "failed", exitCode: 0, usage: null });
  });

  test("the agent process never sees parent secrets", async () => {
    process.env.FACTORY_CANARY = "CANARY-test";
    try {
      const envFile = join(dir, "agent.env");
      await runAgent(spec("claude", `env:${envFile}`));
      const env = readFileSync(envFile, "utf8");
      expect(env).not.toContain("CANARY-test");
      expect(env).toContain(`HOME=${join(dir, "home")}`);
    } finally {
      delete process.env.FACTORY_CANARY;
    }
  });

  test("abort kills the CLI and its orphan-prone children", async () => {
    const pidFile = join(dir, "child.pid");
    const ac = new AbortController();
    const pending = runAgent(spec("claude", `hang:${pidFile}`, { signal: ac.signal }));
    while (!(await Bun.file(pidFile).exists()) || (await Bun.file(pidFile).text()).trim() === "") await Bun.sleep(20);
    const child = Number((await Bun.file(pidFile).text()).trim());
    expect(alive(child)).toBe(true);
    ac.abort();
    const r = await pending;
    expect(r.outcome).toBe("cancelled");
    expect(r.sessionId).toBe("s");
    expect(await gone(child)).toBe(true);
  });

  test("timeout stops the run and is reported as timed_out", async () => {
    const r = await runAgent(spec("claude", `hang:${join(dir, "child2.pid")}`, { timeoutMs: 200 }));
    expect(r.outcome).toBe("timed_out");
    expect(r.usage).toBeNull();
  });

  test("rejects a runId that is not a UUID", async () => {
    await expect(runAgent(spec("claude", "x", { runId: "../../etc" }))).rejects.toThrow("runId must be a lowercase UUID");
  });
});

describe("terminateTree", () => {
  test("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
    const proc = Bun.spawn(["sh", "-c", "(trap '' TERM; sleep 300) & echo $!; wait"], { stdout: "pipe", stderr: "ignore" });
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const child = Number(new TextDecoder().decode(value).trim());
    await Bun.sleep(50); // let the subshell install its trap
    await terminateTree(proc, 200);
    expect(proc.signalCode).not.toBeNull();
    expect(await gone(child)).toBe(true);
  });
});
