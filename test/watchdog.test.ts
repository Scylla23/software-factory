import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "watchdog-out-"));
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

/** Runs the watchdog on the fixture file in `mode`, bounded from here too. */
async function watchdog(mode: string, seconds = 3): Promise<{ code: number | null; stderr: string; evidence: string[] }> {
  const p = Bun.spawn(["/bin/sh", join(ROOT, "scripts/test-watchdog.sh"), "test/fixtures/watchdog.test.ts"], {
    cwd: ROOT,
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

const running = (pattern: string) => Bun.spawnSync(["/usr/bin/pgrep", "-f", pattern], { timeout: 5_000 }).stdout.toString().trim();

describe("test watchdog", () => {
  test("passes bun's own status through and leaves nothing behind", async () => {
    const runs = () => readdirSync(join(ROOT, "test/.state")).filter((n) => n.startsWith("wd-")).sort();
    const before = runs();
    const r = await watchdog("pass");
    expect(r).toMatchObject({ code: 0, evidence: [] });
    expect(runs()).toEqual(before); // the run's own state directory is gone
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
    expect(running("watchdog.test.ts")).toBe("");
  }, 60_000);

  test("processes a run leaves in its state directory are recorded and killed", async () => {
    const r = await watchdog("leave", 60);
    expect(r.code).toBe(125);
    expect(r.evidence[0]).toContain("-leftovers-");
    expect(readFileSync(join(out, r.evidence[0]!, "leftovers.txt"), "utf8")).toContain("sleep 127");
    expect(running("^/bin/sleep 127$")).toBe("");
    expect(readdirSync(join(ROOT, "test/.state")).filter((n) => n.startsWith("wd-")).length).toBeLessThanOrEqual(1); // at most an outer watchdog's
  }, 60_000);
});
