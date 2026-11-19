import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listenerOwnership, type Preview, PreviewError, type PreviewSpec, reserveAttempt, startPreview, toolchainRoots } from "../src/verify/preview";
import { gone } from "./helpers";
import { bounded, BUN_DIR, makeRepo, makeVerifyEnv, probingServerSource, serverSource, type VerifyEnv } from "./verify-helpers";

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
