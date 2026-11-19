import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
let fixtureRoot: string;
let out: string;
beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "watchdog-test-"));
  out = join(fixtureRoot, "evidence");
  mkdirSync(join(fixtureRoot, "scripts"));
  mkdirSync(join(fixtureRoot, "test"));
  copyFileSync(join(ROOT, "scripts/test-watchdog.sh"), join(fixtureRoot, "scripts/test-watchdog.sh"));
  copyFileSync(join(ROOT, "test/fixtures/watchdog.fixture.ts"), join(fixtureRoot, "test/probe.ts"));
});
afterEach(() => rmSync(fixtureRoot, { recursive: true, force: true }));

/** Runs the watchdog on the fixture file in `mode`, bounded from here too. */
async function watchdog(mode: string, seconds = 3): Promise<{ code: number | null; stderr: string; evidence: string[] }> {
  const p = Bun.spawn(["/bin/sh", join(fixtureRoot, "scripts/test-watchdog.sh"), "./test/probe.ts"], {
    cwd: fixtureRoot,
    env: { ...process.env, WATCHDOG_FIXTURE: mode, WATCHDOG_SECONDS: String(seconds), WATCHDOG_OUT: out },
    stdout: "ignore",
    stderr: "pipe",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  const stderr = await new Response(p.stderr).text();
  await p.exited;
  return { code: p.exitCode, stderr, evidence: readdirSync(out) };
}

function expectGone(pid: number) {
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
}

describe("test watchdog", () => {
  test("passes bun's own status through and leaves nothing behind", async () => {
    const r = await watchdog("pass");
    expect(r).toMatchObject({ code: 0, evidence: [] });
    expect(readdirSync(join(fixtureRoot, "test/.state"))).toEqual([]);
  }, 60_000);

  test("a wedged runner is caught from outside: stacks and process state are recorded, and it is killed", async () => {
    const r = await watchdog("wedge");
    expect(r.code).toBe(124);
    expect(r.stderr).toContain("passed 3s");
    expect(r.evidence).toHaveLength(1);
    const ev = join(out, r.evidence[0]!);
    expect(r.evidence[0]).toContain("-overrun-");
    expect(readFileSync(join(ev, "sample.txt"), "utf8")).toContain("Call graph:");
    expect(readFileSync(join(ev, "ps.txt"), "utf8")).toContain("bun test");
    expectGone(Number(r.evidence[0]!.split("-").at(-1)));
  }, 60_000);

  test("processes a run leaves in its state directory are recorded and killed", async () => {
    const r = await watchdog("leave", 60);
    expect(r.code).toBe(125);
    expect(r.evidence[0]).toContain("-leftovers-");
    const leftovers = readFileSync(join(out, r.evidence[0]!, "leftovers.txt"), "utf8").trim();
    expect(leftovers).toContain("/bin/sleep 120");
    for (const row of leftovers.split("\n")) expectGone(Number(row.trim().split(/\s+/)[0]));
    expect(readdirSync(join(fixtureRoot, "test/.state"))).toEqual([]);
  }, 60_000);
});
