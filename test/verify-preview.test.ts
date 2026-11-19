import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listenerOwnership, type Preview, PreviewError, type PreviewSpec, startPreview } from "../src/verify/preview";
import { gone } from "./helpers";
import { makeRepo, makeVerifyEnv, serverSource, type VerifyEnv } from "./verify-helpers";

let env: VerifyEnv;
let started: Preview[] = [];
beforeEach(() => {
  env = makeVerifyEnv();
  started = [];
});
afterEach(async () => {
  for (const p of started) await p.stop();
  env.cleanup();
});

function spec(repo: string, sha: string, extra: Partial<PreviewSpec["project"]> = {}): PreviewSpec {
  return {
    id: crypto.randomUUID(),
    taskKey: `t-${Math.random()}`,
    repo,
    sha,
    previewRoot: env.previewRoot,
    logDir: env.logDir,
    project: { setup: [["/bin/sh", "-c", "echo set-up > setup-ran"]], preview: ["bun", "server.ts"], readyPath: "/health", portRange: [41000, 41999], ...extra },
    setupTimeoutMs: 20_000,
    readyTimeoutMs: 3_000,
    maxLifetimeMs: 60_000,
  };
}

async function start(s: PreviewSpec): Promise<Preview> {
  const p = await startPreview(s, env.config);
  started.push(p);
  return p;
}

/** The error of a start that must fail; a preview that starts anyway is still stopped after the test. */
async function startError(s: PreviewSpec): Promise<PreviewError> {
  const r = await start(s).catch((e: unknown) => e);
  expect(r).toBeInstanceOf(PreviewError);
  return r as PreviewError;
}

/** The pid listening on the preview's port, by asking lsof. */
function serverPid(port: number): number {
  const out = Bun.spawnSync(["/usr/sbin/lsof", "-n", "-P", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "p"]).stdout.toString();
  return Number(out.split("\n").find((l) => l.startsWith("p"))!.slice(1));
}

const DETACH = ["/usr/bin/perl", "-MPOSIX", "-e", "exit 0 if fork; POSIX::setsid(); exit 0 if fork; exec '/bin/sleep', '305'"];

/** The leftover pids a sweep reported, so a check never depends on strays from other runs. */
function reportedLeftovers(text: string): number[] {
  const m = /still running in the worktree after the run: ([\d, ]+)/.exec(text);
  return m ? m[1]!.split(",").map((s) => Number(s.trim())) : [];
}

async function allGone(pids: readonly number[]): Promise<boolean> {
  for (const pid of pids) if (!(await gone(pid))) return false;
  return true;
}

describe("startPreview", () => {
  test("serves the exact commit after setup, then tears down with nothing left", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("commit-one") }, { "server.ts": serverSource("commit-two") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    expect(await (await fetch(`${p.origin}/`)).text()).toBe("commit-one");
    expect(readFileSync(join(p.worktree, "setup-ran"), "utf8")).toBe("set-up\n");
    expect(p.port).toBeGreaterThanOrEqual(41000);
    const pid = serverPid(p.port);
    const report = await p.stop();
    expect(report).toMatchObject({ noKnownSurvivors: true, quarantineReasons: [], removed: true });
    expect(report.cleanup?.survivors).toEqual([]);
    expect(await gone(pid)).toBe(true);
    expect(existsSync(p.worktree)).toBe(false);
    expect(existsSync(p.home)).toBe(false);
    expect(await p.stop()).toBe(report);
    expect(readdirSync(env.logDir).sort()).toEqual([`${p.id}.preview.log`, `${p.id}.setup-0.log`]);
  });

  test("a command beside the running preview cannot read denied files or the factory's env, and leaves the preview up", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    process.env.FACTORY_CANARY = "FACTORY-CANARY-test";
    let p: Preview;
    try {
      p = await start(spec(repo.path, repo.shas[0]!));
    } finally {
      delete process.env.FACTORY_CANARY;
    }
    const r = await p.run(["/bin/sh", "-c", `cat '${env.home}/.ssh/id_test' 2>&1; env; echo PORT-IS-$PORT`], { network: "serve", name: "probe", timeoutMs: 10_000 });
    const out = readFileSync(r.logPath, "utf8");
    expect(r).toMatchObject({ exitCode: 0, stopped: null, quarantineReasons: [] });
    expect(out).toContain("Operation not permitted");
    expect(out).not.toContain("PLANTED-SSH-SECRET");
    expect(out).not.toContain("FACTORY_CANARY");
    expect(out).toContain(`PORT-IS-${p.port}`);
    expect(await (await fetch(`${p.origin}/`)).text()).toBe("up");
  });

  test("whatever a command beside the preview leaves running is found and killed, and the preview survives", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    const r = await p.run(DETACH, { network: "none", name: "leaver", timeoutMs: 10_000 });
    const leftovers = reportedLeftovers(r.quarantineReasons.join("\n"));
    expect(leftovers.length).toBe(1);
    expect(await allGone(leftovers)).toBe(true);
    expect(await (await fetch(`${p.origin}/`)).text()).toBe("up");
  });

  test("a failing setup command stops everything and removes the worktree", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x") }]);
    const s = spec(repo.path, repo.shas[0]!, { setup: [["/bin/sh", "-c", "echo boom >&2; exit 7"]] });
    const err = await startError(s);
    expect(err.message).toContain("setup command 0 (/bin/sh) did not succeed: exit 7");
    expect(err.logTail).toContain("boom");
    expect(err.teardown).toMatchObject({ removed: true, quarantineReasons: [] });
    expect(readdirSync(env.previewRoot)).toEqual([]);
  });

  test("a setup command that leaves a detached process fails the preview, and the process is killed", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x") }]);
    const err = await startError(spec(repo.path, repo.shas[0]!, { setup: [DETACH] }));
    const leftovers = reportedLeftovers(err.message);
    expect(leftovers.length).toBe(1);
    expect(await allGone(leftovers)).toBe(true);
    expect(err.teardown?.removed).toBe(true);
  });

  test("a process the preview detached from its group is found and killed at teardown, and the worktree is kept", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const detachThenServe = `/usr/bin/perl -MPOSIX -e "exit 0 if fork; POSIX::setsid(); exit 0 if fork; exec '/bin/sleep', '305'"; exec bun server.ts`;
    const p = await start(spec(repo.path, repo.shas[0]!, { preview: ["/bin/sh", "-c", detachThenServe] }));
    const report = await p.stop();
    const leftovers = reportedLeftovers(report.quarantineReasons.join("\n"));
    expect(leftovers.length).toBe(1);
    expect(await allGone(leftovers)).toBe(true);
    expect(report).toMatchObject({ noKnownSurvivors: true, removed: false });
    expect(existsSync(p.worktree)).toBe(true);
  });

  test("a preview that never answers 200 is torn down after the bound", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x", { healthStatus: 503 }) }]);
    const t0 = Date.now();
    const err = await startError(spec(repo.path, repo.shas[0]!));
    expect(err.message).toContain("last probe: status 503");
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(err.teardown).toMatchObject({ noKnownSurvivors: true, removed: true });
    expect(readdirSync(env.previewRoot)).toEqual([]);
  });

  test("a preview that exits is reported as exited, not waited out", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x", { exitCode: 3 }) }]);
    const t0 = Date.now();
    const err = await startError({ ...spec(repo.path, repo.shas[0]!), readyTimeoutMs: 10_000 });
    expect(err.message).toContain("the preview process exited");
    expect(Date.now() - t0).toBeLessThan(8_000);
  });

  test("refuses a ready path with a query or scheme, and a preview root inside the state root", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x") }]);
    await expect(start(spec(repo.path, repo.shas[0]!, { readyPath: "http://x/" }))).rejects.toThrow("ready path");
    await expect(start({ ...spec(repo.path, repo.shas[0]!), previewRoot: env.logDir })).rejects.toThrow("overlaps the state root");
  });
});

describe("listenerOwnership", () => {
  test("accepts the root's own listener and refuses a stranger's", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = server.port!;
    try {
      const me = { pid: process.pid, identity: null, exitedAt: () => null };
      expect(listenerOwnership(env.config, port, me)).toMatchObject({ ok: true, pids: [process.pid] });
      const stranger = Bun.spawn(["/bin/sleep", "30"]);
      const other = { pid: stranger.pid, identity: null, exitedAt: () => null };
      const r = listenerOwnership(env.config, port, other);
      stranger.kill();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(`listener pids ${process.pid} are outside`);
    } finally {
      server.stop(true);
    }
    expect(listenerOwnership(env.config, port, { pid: process.pid, identity: null, exitedAt: () => null })).toMatchObject({ ok: false, reason: "nothing of this user listens on it" });
  });
});
