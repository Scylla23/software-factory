import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { copyCapped, listenerOwnership, MAX_LOG_BYTES, type Preview, PreviewError, type PreviewSpec, reserveAttempt, startPreview, tail, toolchainRoots, waitReady } from "../src/verify/preview";
import { portIsFree } from "../src/verify/port";
import { gone } from "./helpers";
import { bounded, BUN_DIR, makeRepo, makeVerifyEnv, probingServerSource, serverSource, type VerifyEnv } from "./verify-helpers";

let env: VerifyEnv;
let started: Promise<Preview>[] = [];
beforeEach(() => {
  env = makeVerifyEnv();
  started = [];
});
afterEach(async () => {
  // Waits for starts a failed test never awaited, so nothing still runs in the env once it is removed.
  for (const r of await Promise.allSettled(started)) if (r.status === "fulfilled") await r.value.stop();
  env.cleanup();
});

const previews = () => join(env.stateRoot, "previews");

function spec(repo: string, sha: string, extra: Partial<PreviewSpec["project"]> = {}): PreviewSpec {
  return {
    id: crypto.randomUUID(),
    taskKey: `t-${Math.random()}`,
    repo,
    sha,
    logDir: env.logDir,
    project: { setup: [["/bin/sh", "-c", "echo set-up > setup-ran"]], egress: ["registry.npmjs.org"], preview: ["bun", "server.ts"], readyPath: "/health", portRange: [41000, 41999], ...extra },
    setupTimeoutMs: 20_000,
    readyTimeoutMs: 3_000,
    maxLifetimeMs: 60_000,
  };
}

function start(s: PreviewSpec): Promise<Preview> {
  const p = startPreview(s, env.config);
  started.push(p);
  return p;
}

/** The error of a start that must fail; a preview that starts anyway is still stopped after the test. */
async function startError(s: PreviewSpec): Promise<PreviewError> {
  const r = await start(s).catch((e: unknown) => e);
  expect(r).toBeInstanceOf(PreviewError);
  return r as PreviewError;
}

/** Two adjacent free ports, for a range a test fully controls. */
async function freePair(): Promise<number> {
  for (let low = 42000 + Math.floor(Math.random() * 500) * 2; low < 43000; low += 2) if ((await portIsFree(low)) && (await portIsFree(low + 1))) return low;
  throw new Error("no two adjacent free ports in 42000-43000");
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
    expect(p.worktree).toBe(join(previews(), p.id, "worktree"));
    expect(p.home).toBe(join(previews(), p.id, "home"));
    const pid = serverPid(p.port);
    const report = await p.stop();
    expect(report).toMatchObject({ noKnownSurvivors: true, quarantineReasons: [], removed: true });
    expect(report.cleanup?.survivors).toEqual([]);
    expect(await gone(pid)).toBe(true);
    expect(existsSync(p.worktree)).toBe(false);
    expect(existsSync(p.home)).toBe(false);
    expect(readdirSync(previews())).toEqual([]);
    expect(await p.stop()).toBe(report);
    expect(readdirSync(env.logDir).sort()).toEqual([`${p.id}.egress.log`, `${p.id}.preview.log`, `${p.id}.setup-0.log`]);
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
    // State beside this attempt: a factory file and another attempt's directory.
    writeFileSync(join(env.stateRoot, "github-app.json"), "STATE-SECRET\n");
    mkdirSync(join(previews(), "00000000-0000-4000-8000-000000000000", "home"), { recursive: true, mode: 0o700 });
    writeFileSync(join(previews(), "00000000-0000-4000-8000-000000000000", "home", "k"), "OTHER-ATTEMPT\n");
    const script = `cat '${env.home}/.ssh/id_test' 2>&1; env; echo PORT-IS-$PORT; echo HEAD-IS-$(git rev-parse HEAD); cat '${env.stateRoot}/github-app.json' '${previews()}/00000000-0000-4000-8000-000000000000/home/k' 2>&1; true`;
    const r = await p.run(["/bin/sh", "-c", script], { network: "serve", name: "probe", timeoutMs: 10_000 });
    const out = readFileSync(r.logPath, "utf8");
    expect(out).not.toContain("STATE-SECRET");
    expect(out).not.toContain("OTHER-ATTEMPT");
    expect(r).toMatchObject({ exitCode: 0, stopped: null, quarantineReasons: [] });
    expect(out).toContain("Operation not permitted");
    expect(out).not.toContain("PLANTED-SSH-SECRET");
    expect(out).not.toContain("FACTORY_CANARY");
    expect(out).toContain(`PORT-IS-${p.port}`);
    expect(out).toContain(`HEAD-IS-${repo.shas[0]}`); // its own git dirs are readable
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

  test("setup egress dies with the phase: a detached setup child that escaped the sweeps loses the proxy when setup ends", async () => {
    // The leaker moves to / at once, so no sweep finds it by its working directory (the documented blind spot), and
    // keeps asking the proxy for a host outside the allowlist, logging the CONNECT status it gets.
    const leak = `cd / || exit 1; echo $$ > "$HOME/leak.pid"; i=0; while [ $i -lt 150 ]; do
  c=$(/usr/bin/curl -s -m 2 -o /dev/null -w '%{http_connect}' -p -x "$HTTPS_PROXY" http://denied.example:443/); echo "$c" >> "$HOME/leak.log"; i=$((i+1)); sleep 0.1; done`;
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up"), "leak.sh": leak }]);
    const setup = [["/bin/sh", "-c", `/usr/bin/perl -MPOSIX -e 'exit 0 if fork; POSIX::setsid(); exit 0 if fork; exec "/bin/sh", "leak.sh"'; sleep 1`]];
    const p = await start(spec(repo.path, repo.shas[0]!, { setup }));
    const logPath = join(p.home, "leak.log");
    const codes = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n") : []);
    // A curl can also time out (000) while the factory's event loop is briefly busy, so judge a whole window after the
    // phase ended: every attempt in it must fail, where a proxy still alive would answer 403 again.
    const atPhaseEnd = codes().length;
    await Bun.sleep(1_500);
    const pid = Number(readFileSync(join(p.home, "leak.pid"), "utf8"));
    process.kill(pid, "SIGKILL");
    const seen = codes();
    const after = seen.slice(atPhaseEnd);
    expect(seen[0]).toBe("403"); // during setup: the proxy answers, and refuses the host
    expect(after.length).toBeGreaterThanOrEqual(3);
    expect(after).toEqual(after.map(() => "000")); // after setup: nothing listens; the profile allows no other destination
    expect(readFileSync(p.logs.find((l) => l.endsWith(".egress.log"))!, "utf8")).toContain("DENY denied.example:443 host not in the allowlist");
  });

  test("the preview may call itself on its port, but no other loopback service and nothing outbound", async () => {
    const owner = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("owner-service") });
    try {
      const repo = makeRepo(env.repos, "app", [{ "server.ts": probingServerSource(owner.port!) }]);
      const p = await start(spec(repo.path, repo.shas[0]!));
      const get = async (path: string) => (await bounded(`${p.origin}${path}`)).text();
      expect(await get("/self")).toBe("self:api");
      expect(await get("/lateral")).toBe("lateral:DENIED");
      expect(await get("/out")).toBe("out:DENIED");
    } finally {
      owner.stop(true);
    }
  });

  test("a command beside the preview can never get egress", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    await expect(p.run(["/usr/bin/true"], { network: "proxy" as never, name: "sneaky", timeoutMs: 5_000 })).rejects.toThrow("may not have network");
    await expect(p.run(["/usr/bin/true"], { network: "outbound" as never, name: "sneaky", timeoutMs: 5_000 })).rejects.toThrow("may not have network");
  });

  test("the maximum lifetime tears the whole preview down, not just its server, with the report stop() returns", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start({ ...spec(repo.path, repo.shas[0]!), maxLifetimeMs: 1_500 });
    for (let i = 0; i < 100 && existsSync(join(previews(), p.id)); i++) await Bun.sleep(100);
    expect(existsSync(join(previews(), p.id))).toBe(false);
    const report = await p.stop();
    expect(report).toMatchObject({ noKnownSurvivors: true, removed: true });
    expect(report.cleanup).not.toBeNull(); // the server was stopped at the bound
    await expect(p.run(["/usr/bin/true"], { network: "none", name: "late", timeoutMs: 5_000 })).rejects.toThrow("preview was stopped");
  });

  test("a server that exits after it was ready ends the preview the same way", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up", { exitAfterMs: 1_000 }) }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    for (let i = 0; i < 100 && existsSync(join(previews(), p.id)); i++) await Bun.sleep(100);
    expect(existsSync(join(previews(), p.id))).toBe(false);
    expect(await p.stop()).toMatchObject({ cleanup: null, noKnownSurvivors: true, removed: true });
  });

  test("stop cancels a running check before it sweeps, and refuses new ones", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    const long = p.run(["/bin/sleep", "300"], { network: "none", name: "long", timeoutMs: 600_000 });
    const queued = p.run(["/usr/bin/true"], { network: "none", name: "queued", timeoutMs: 5_000 });
    await Bun.sleep(300);
    const report = await p.stop();
    expect(await long).toMatchObject({ stopped: "cancelled", quarantineReasons: [] });
    await expect(queued).rejects.toThrow("preview was stopped");
    expect(report).toMatchObject({ noKnownSurvivors: true, quarantineReasons: [], removed: true });
    expect(Bun.spawnSync(["/usr/bin/pgrep", "-fx", "/bin/sleep 300"], { timeout: 5_000 }).stdout.toString().trim()).toBe("");
    await expect(p.run(["/usr/bin/true"], { network: "none", name: "after", timeoutMs: 5_000 })).rejects.toThrow("preview was stopped");
  });

  test("a removal that fails is reported as a quarantine reason instead of rejecting stop", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    const stray = join(previews(), p.id, "stray");
    writeFileSync(stray, "");
    const report = await p.stop();
    expect(report.removed).toBe(false);
    expect(report.quarantineReasons.join(" ")).toContain("cleanup failed");
    rmSync(join(previews(), p.id), { recursive: true, force: true });
  });

  test("a stop that lands while a check is still being spawned stops that check too", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    const long = p.run(["/bin/sleep", "300"], { network: "none", name: "long", timeoutMs: 600_000 });
    // The check is spawned on the next microtask; its spawn waits in Bun.spawnSync, which runs this due timer meanwhile.
    const stopped = new Promise<unknown>((resolve) => setTimeout(() => resolve(p.stop()), 0));
    const t = Date.now();
    while (Date.now() - t < 5) {}
    expect(await long).toMatchObject({ stopped: "cancelled" });
    expect(await stopped).toMatchObject({ noKnownSurvivors: true, removed: true });
  }, 20_000);

  test("a check's log keeps only the first MAX_LOG_BYTES; the rest is drained, so the command finishes", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    const r = await p.run(["/bin/sh", "-c", `/usr/bin/head -c ${MAX_LOG_BYTES + 4 * 1024 * 1024} /dev/zero; echo done-writing >&2`], { network: "none", name: "noisy", timeoutMs: 60_000 });
    expect(r).toMatchObject({ exitCode: 0, quarantineReasons: [] });
    const size = statSync(r.logPath).size;
    expect(size).toBeGreaterThanOrEqual(MAX_LOG_BYTES);
    expect(size).toBeLessThan(MAX_LOG_BYTES + 1024);
    expect(tail(r.logPath, 200)).toContain(`[factory: output capped at ${MAX_LOG_BYTES} bytes;`);
  }, 30_000);

  test("concurrent checks run one at a time, so one check's sweep never kills another's process", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    const [a, b] = await Promise.all([
      p.run(["/bin/sh", "-c", "sleep 0.3; echo A"], { network: "none", name: "check-a", timeoutMs: 10_000 }),
      p.run(["/bin/sh", "-c", "sleep 0.6; echo B"], { network: "none", name: "check-b", timeoutMs: 10_000 }),
    ]);
    expect([a.exitCode, a.quarantineReasons, b.exitCode, b.quarantineReasons]).toEqual([0, [], 0, []]);
    expect(readFileSync(b.logPath, "utf8")).toBe("B\n");
  });

  test("a start whose port another process takes before the server binds retries on the next port", async () => {
    const low = await freePair();
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("ours") }]);
    const s = spec(repo.path, repo.shas[0]!, { preview: ["/bin/sh", "-c", "sleep 1; exec bun server.ts"], portRange: [low, low + 1] });
    const ports = join(env.stateRoot, "ports");
    const starting = start(s);
    // The preview log is opened only after the lease and its probe succeeded; the server then waits 1s to bind.
    for (let i = 0; i < 200 && !existsSync(join(env.logDir, `${s.id}.preview.log`)); i++) await Bun.sleep(20);
    const taken = Number(readdirSync(ports).find((n) => n.endsWith(".lease"))!.split(".")[0]);
    const stranger = Bun.serve({ hostname: "127.0.0.1", port: taken, fetch: () => new Response("stranger") });
    try {
      const p = await starting;
      expect(p.port).toBe(taken === low ? low + 1 : low);
      expect(await (await bounded(p.origin)).text()).toBe("ours");
      expect(p.logs.some((l) => l.endsWith(".preview-2.log"))).toBe(true);
      expect(readdirSync(ports)).toEqual([`${p.port}.lease`]);
      expect(await p.stop()).toMatchObject({ noKnownSurvivors: true, removed: true });
      expect(readdirSync(ports)).toEqual([]);
    } finally {
      stranger.stop(true);
    }
  });

  test("two starts of the same task at once get different ports", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    // Each server binds a second after its port is chosen, so both choose before either binds.
    const s = spec(repo.path, repo.shas[0]!, { preview: ["/bin/sh", "-c", "sleep 1; exec bun server.ts"] });
    const [a, b] = await Promise.all([start(s), start({ ...s, id: crypto.randomUUID() })]);
    expect(a.port).not.toBe(b.port);
    // The leases kept them apart from the start: neither had to lose a bind and retry.
    expect([...a.logs, ...b.logs].filter((l) => l.includes(".preview-"))).toEqual([]);
    expect([await (await bounded(`${a.origin}/health`)).text(), await (await bounded(`${b.origin}/health`)).text()]).toEqual(["ok", "ok"]);
  });

  test("serving() tells whether the ready server still holds its port alone", async () => {
    const repo = makeRepo(env.repos, "app", [
      {
        "server.ts": `const s = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch(req) {
  if (new URL(req.url).pathname === "/close") { setTimeout(() => s.stop(true), 10); return new Response("bye"); }
  return new Response("up");
} });
setInterval(() => {}, 1000);
`,
      },
    ]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    expect(p.serving()).toMatchObject({ ok: true });
    await (await bounded(`${p.origin}/close`)).text();
    await Bun.sleep(200);
    expect(p.serving()).toMatchObject({ ok: false, reason: "nothing of this user listens on it" });
    const stranger = Bun.serve({ hostname: "127.0.0.1", port: p.port, fetch: () => new Response("stranger") });
    try {
      expect((p.serving() as { reason: string }).reason).toContain("outside the preview's process tree");
    } finally {
      stranger.stop(true);
    }
    await p.stop();
    expect(p.serving()).toEqual({ ok: false, reason: "preview was stopped" });
  });

  test("a failing setup command stops everything and removes the worktree", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x") }]);
    const s = spec(repo.path, repo.shas[0]!, { setup: [["/bin/sh", "-c", "echo boom >&2; exit 7"]] });
    const err = await startError(s);
    expect(err.message).toContain("setup command 0 (/bin/sh) did not succeed: exit 7");
    expect(err.logTail).toContain("boom");
    expect(err.teardown).toMatchObject({ removed: true, quarantineReasons: [] });
    expect(readdirSync(previews())).toEqual([]);
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
    expect(readdirSync(previews())).toEqual([]);
  });

  test("a preview that exits is reported as exited, not waited out", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x", { exitCode: 3 }) }]);
    const t0 = Date.now();
    const err = await startError({ ...spec(repo.path, repo.shas[0]!), readyTimeoutMs: 10_000 });
    expect(err.message).toContain("the preview process exited");
    expect(Date.now() - t0).toBeLessThan(8_000);
  });

  test("refuses a ready path with a query or scheme", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x") }]);
    await expect(start(spec(repo.path, repo.shas[0]!, { readyPath: "http://x/" }))).rejects.toThrow("ready path");
  });

  test("a directory already present for the attempt is refused and left untouched", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x") }]);
    const s = spec(repo.path, repo.shas[0]!);
    mkdirSync(join(previews(), s.id, "home"), { recursive: true, mode: 0o700 });
    writeFileSync(join(previews(), s.id, "home", "older"), "not this attempt's");
    await expect(start(s)).rejects.toThrow("already has a directory");
    expect(readFileSync(join(previews(), s.id, "home", "older"), "utf8")).toBe("not this attempt's");
  });

  test("the previews root must be private and outside every agent-writable root", () => {
    expect(() => reserveAttempt({ ...env.config, untrustedRoots: [env.stateRoot] }, crypto.randomUUID())).toThrow("overlaps agent-writable");
    mkdirSync(previews(), { recursive: true });
    chmodSync(previews(), 0o755);
    expect(() => reserveAttempt(env.config, crypto.randomUUID())).toThrow("accessible to group or others");
    chmodSync(previews(), 0o700);
    const id = crypto.randomUUID();
    expect(reserveAttempt(env.config, id)).toBe(join(previews(), id));
    expect(statSync(join(previews(), id)).mode & 0o777).toBe(0o700);
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

describe("toolchainRoots", () => {
  test("requires existing roots outside agent-writable dirs that cover every tool dir", () => {
    expect(toolchainRoots([BUN_DIR, "/usr/bin"], [BUN_DIR], [env.repos])).toEqual([BUN_DIR]);
    expect(() => toolchainRoots([BUN_DIR], [], [])).toThrow(`tool dir ${BUN_DIR} is outside every toolchain root`);
    expect(() => toolchainRoots([BUN_DIR], [BUN_DIR], [BUN_DIR])).toThrow("is under agent-writable");
    expect(() => toolchainRoots([], ["/no/such/toolchain"], [])).toThrow("sandbox toolchain path does not exist: /no/such/toolchain");
  });
});

describe("bounded reads", () => {
  test("readiness needs only the status: an endless health body does not hold it up", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(new ReadableStream({ pull: async (c) => { await Bun.sleep(10); c.enqueue(new Uint8Array(64 * 1024)); } })),
    });
    try {
      const t = Date.now();
      expect(await waitReady(`http://127.0.0.1:${server.port}/health`, 3_000, new Promise(() => {}))).toEqual({ ok: true });
      expect(Date.now() - t).toBeLessThan(1_000);
    } finally {
      server.stop(true);
    }
  });

  test("tail reads only the end of a log, even one far larger than memory allows reading whole", () => {
    const dir = join(env.stateRoot, "tail");
    mkdirSync(dir);
    const path = join(dir, "big.log");
    const fd = openSync(path, "w", 0o600);
    ftruncateSync(fd, 3 * 1024 ** 3); // sparse: no disk used
    writeSync(fd, "the last line\n", 3 * 1024 ** 3);
    closeSync(fd);
    expect(tail(path, 50)).toEndWith("the last line\n");
    expect(tail(path, 50).length).toBe(50);
    expect(tail(join(dir, "missing.log"))).toBe("");
  });

  test("copyCapped keeps the first bytes, counts the rest, and closes the log when every pipe has closed", async () => {
    const path = join(env.stateRoot, "copy.log");
    const fd = openSync(path, "wx", 0o600);
    const out = Readable.from([Buffer.from("aaaa"), Buffer.from("bbbb")]);
    const err = new Readable({ read() {} }); // stays open until it ends below
    const copy = copyCapped([out, err], fd, 6);
    let finished = false;
    void copy.done.then(() => (finished = true));
    await Bun.sleep(50);
    expect(finished).toBe(false); // one pipe is still open
    err.push(Buffer.from("cc"));
    err.push(null);
    await copy.done;
    expect(readFileSync(path, "utf8")).toBe("aaaabb\n[factory: output capped at 6 bytes; 4 more bytes dropped]\n");
    expect(() => writeSync(fd, "x")).toThrow(); // closed
    copy.close(); // idempotent
  });
});
