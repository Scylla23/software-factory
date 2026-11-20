import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { verificationErrorCheck } from "../src/factory/verify";
import { config } from "../factory.config";
import { createAttempt } from "../src/dispatch/attempt";
import { agentEnv, effectiveDenyRead } from "../src/dispatch/policy";
import { skillPolicy } from "../src/dispatch/skill-policy";
import { codexConfigArgs, codexReadable } from "../src/dispatch/codex";
import { Readable } from "node:stream";
import { join } from "node:path";
import { copyCapped, listenerOwnership, MAX_LOG_BYTES, type Preview, PreviewError, type PreviewSpec, prepareAgentCheckout, reserveAttempt, startPreview, tail, toolchainRoots, waitReady } from "../src/verify/preview";
import { portIsFree } from "../src/verify/port";
import { gone } from "./helpers";
import { bounded, BUN_DIR, makeRepo, makeVerifyEnv, probingServerSource, serverSource, settlingTest, spawnBounded, type VerifyEnv } from "./verify-helpers";

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
const it = settlingTest(() => started);

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
  const out = spawnBounded(["/usr/sbin/lsof", "-n", "-P", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "p"]).stdout;
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
  it("serves the exact commit after setup, then tears down with nothing left", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("commit-one") }, { "server.ts": serverSource("commit-two") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    expect(await (await bounded(`${p.origin}/`)).text()).toBe("commit-one");
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

  it("a command beside the running preview cannot read denied files or the factory's env, and leaves the preview up", async () => {
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
    expect(await (await bounded(`${p.origin}/`)).text()).toBe("up");
  });

  it("whatever a command beside the preview leaves running is found and killed, and the preview survives", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    const r = await p.run(DETACH, { network: "none", name: "leaver", timeoutMs: 10_000 });
    const leftovers = reportedLeftovers(r.quarantineReasons.join("\n"));
    expect(leftovers.length).toBe(1);
    expect(await allGone(leftovers)).toBe(true);
    expect(await (await bounded(`${p.origin}/`)).text()).toBe("up");
  });

  it("setup egress dies with the phase: a detached setup child that escaped the sweeps finds only a factory-held port that refuses it, in later phases too", async () => {
    // The leaker moves to / at once, so no sweep finds it by its working directory (the documented blind spot), and
    // keeps asking the proxy for a host outside the allowlist, logging the CONNECT status it gets. It writes the proxy's
    // port (never the credential) so the test can check who holds it.
    const leak = `cd / || exit 1; echo $$ > "$HOME/leak.pid"; echo "\${HTTPS_PROXY##*:}" > "$HOME/proxy.port"; i=0; while [ $i -lt 200 ]; do
  c=$(/usr/bin/curl -s -m 2 -o /dev/null -w '%{http_connect}' -p -x "$HTTPS_PROXY" http://denied.example:443/); echo "$c" >> "$HOME/leak.log"; i=$((i+1)); sleep 0.1; done`;
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up"), "leak.sh": leak }]);
    const setup = [["/bin/sh", "-c", `/usr/bin/perl -MPOSIX -e 'exit 0 if fork; POSIX::setsid(); exit 0 if fork; exec "/bin/sh", "leak.sh"'; sleep 1`]];
    const p = await start(spec(repo.path, repo.shas[0]!, { setup }));
    const pid = Number(readFileSync(join(p.home, "leak.pid"), "utf8"));
    try {
      const logPath = join(p.home, "leak.log");
      const codes = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n") : []);
      const atPhaseEnd = codes().length;
      const port = Number(readFileSync(join(p.home, "proxy.port"), "utf8"));
      expect(env.config.egress.ports).toContain(port);
      expect(await gone(pid)).toBe(false); // the survivor outlived its phase
      // An unrelated listener cannot take the port the survivor was granted.
      let bind = "BOUND";
      try {
        Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
      } catch (err) {
        bind = String((err as NodeJS.ErrnoException).code);
      }
      expect(bind).toBe("EADDRINUSE");

      // A later setup phase on the same port with its own credential works; the survivor's credential stays refused.
      const next = makeRepo(env.repos, "next", [{ "server.ts": serverSource("next") }]);
      const nextSetup = [["/bin/sh", "-c", `echo "\${HTTPS_PROXY##*:}" > "$HOME/proxy.port"; /usr/bin/curl -s -m 5 -o /dev/null -w '%{http_connect}' -p -x "$HTTPS_PROXY" http://denied.example:443/ > "$HOME/connect.code"; sleep 1.5`]];
      const q = await start(spec(next.path, next.shas[0]!, { setup: nextSetup }));
      expect(Number(readFileSync(join(q.home, "proxy.port"), "utf8"))).toBe(port);
      expect(readFileSync(join(q.home, "connect.code"), "utf8")).toBe("403"); // its credential passed; the host is refused
      const nextLog = readFileSync(q.logs.find((l) => l.endsWith(".egress.log"))!, "utf8");
      expect(nextLog).toContain("DENY denied.example:443 missing or wrong phase credential"); // the survivor, during the new phase
      await q.stop();

      await Bun.sleep(500);
      const seen = codes();
      const after = seen.slice(atPhaseEnd);
      expect(seen[0]).toBe("403"); // during setup: the proxy answers, and refuses the host
      // After setup, every attempt is refused by the factory (407) or timed out while its event loop was busy (000);
      // a credential still live would get 403 again.
      expect(after.filter((c) => c === "407").length).toBeGreaterThanOrEqual(3);
      expect(after.filter((c) => c !== "407" && c !== "000")).toEqual([]);
      expect(readFileSync(p.logs.find((l) => l.endsWith(".egress.log"))!, "utf8")).toContain("DENY denied.example:443 host not in the allowlist");
    } finally {
      process.kill(pid, "SIGKILL");
    }
  }, 30_000);

  it("a preview that listens beyond 127.0.0.1 is refused, even on its own port", async () => {
    const wide = serverSource("wide").replace('hostname: "127.0.0.1"', 'hostname: "0.0.0.0"');
    const repo = makeRepo(env.repos, "app", [{ "server.ts": wide }]);
    const e = await startError(spec(repo.path, repo.shas[0]!));
    expect(e.message).toMatch(/is not served by the preview: the preview listens on \*:\d+, beyond 127\.0\.0\.1/);
  });

  it("the preview may call itself on its port, but no other loopback service and nothing outbound", async () => {
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

  it("a command beside the preview can never get egress", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    await expect(p.run(["/usr/bin/true"], { network: "proxy" as never, name: "sneaky", timeoutMs: 5_000 })).rejects.toThrow("may not have network");
    await expect(p.run(["/usr/bin/true"], { network: "outbound" as never, name: "sneaky", timeoutMs: 5_000 })).rejects.toThrow("may not have network");
  });

  it("the maximum lifetime tears the whole preview down, not just its server, with the report stop() returns", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start({ ...spec(repo.path, repo.shas[0]!), maxLifetimeMs: 1_500 });
    for (let i = 0; i < 100 && existsSync(join(previews(), p.id)); i++) await Bun.sleep(100);
    expect(existsSync(join(previews(), p.id))).toBe(false);
    const report = await p.stop();
    expect(report).toMatchObject({ noKnownSurvivors: true, removed: true });
    expect(report.cleanup).not.toBeNull(); // the server was stopped at the bound
    await expect(p.run(["/usr/bin/true"], { network: "none", name: "late", timeoutMs: 5_000 })).rejects.toThrow("preview was stopped");
  });

  it("a server that exits after it was ready ends the preview the same way", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up", { exitAfterMs: 1_000 }) }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    for (let i = 0; i < 100 && existsSync(join(previews(), p.id)); i++) await Bun.sleep(100);
    expect(existsSync(join(previews(), p.id))).toBe(false);
    expect(await p.stop()).toMatchObject({ cleanup: null, noKnownSurvivors: true, removed: true });
  });

  it("stop cancels a running check before it sweeps, and refuses new ones", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    const long = p.run(["/bin/sleep", "300"], { network: "none", name: "long", timeoutMs: 600_000 });
    const queued = p.run(["/usr/bin/true"], { network: "none", name: "queued", timeoutMs: 5_000 });
    await Bun.sleep(300);
    const report = await p.stop();
    expect(await long).toMatchObject({ stopped: "cancelled", quarantineReasons: [] });
    await expect(queued).rejects.toThrow("preview was stopped");
    expect(report).toMatchObject({ noKnownSurvivors: true, quarantineReasons: [], removed: true });
    expect(spawnBounded(["/usr/bin/pgrep", "-fx", "/bin/sleep 300"]).stdout.trim()).toBe("");
    await expect(p.run(["/usr/bin/true"], { network: "none", name: "after", timeoutMs: 5_000 })).rejects.toThrow("preview was stopped");
  });

  it("a removal that fails is reported as a quarantine reason instead of rejecting stop", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    const stray = join(previews(), p.id, "stray");
    writeFileSync(stray, "");
    const report = await p.stop();
    expect(report.removed).toBe(false);
    expect(report.quarantineReasons.join(" ")).toContain("cleanup failed");
    rmSync(join(previews(), p.id), { recursive: true, force: true });
  });

  it("a stop that lands while a check is still being spawned stops that check too", async () => {
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

  it("a check's log keeps only the first MAX_LOG_BYTES; the rest is drained, so the command finishes", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    const r = await p.run(["/bin/sh", "-c", `/usr/bin/head -c ${MAX_LOG_BYTES + 4 * 1024 * 1024} /dev/zero; echo done-writing >&2`], { network: "none", name: "noisy", timeoutMs: 60_000 });
    expect(r).toMatchObject({ exitCode: 0, quarantineReasons: [] });
    const size = statSync(r.logPath).size;
    expect(size).toBeGreaterThanOrEqual(MAX_LOG_BYTES);
    expect(size).toBeLessThan(MAX_LOG_BYTES + 1024);
    expect(tail(r.logPath, 200)).toContain(`[factory: output capped at ${MAX_LOG_BYTES} bytes;`);
  }, 30_000);

  it("concurrent checks run one at a time, so one check's sweep never kills another's process", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    const p = await start(spec(repo.path, repo.shas[0]!));
    const [a, b] = await Promise.all([
      p.run(["/bin/sh", "-c", "sleep 0.3; echo A"], { network: "none", name: "check-a", timeoutMs: 10_000 }),
      p.run(["/bin/sh", "-c", "sleep 0.6; echo B"], { network: "none", name: "check-b", timeoutMs: 10_000 }),
    ]);
    expect([a.exitCode, a.quarantineReasons, b.exitCode, b.quarantineReasons]).toEqual([0, [], 0, []]);
    expect(readFileSync(b.logPath, "utf8")).toBe("B\n");
  });

  it("a start whose port another process takes before the server binds retries on the next port", async () => {
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

  it("two starts of the same task at once get different ports", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("up") }]);
    // Each server binds a second after its port is chosen, so both choose before either binds.
    const s = spec(repo.path, repo.shas[0]!, { preview: ["/bin/sh", "-c", "sleep 1; exec bun server.ts"] });
    const [a, b] = await Promise.all([start(s), start({ ...s, id: crypto.randomUUID() })]);
    expect(a.port).not.toBe(b.port);
    // The leases kept them apart from the start: neither had to lose a bind and retry.
    expect([...a.logs, ...b.logs].filter((l) => l.includes(".preview-"))).toEqual([]);
    expect([await (await bounded(`${a.origin}/health`)).text(), await (await bounded(`${b.origin}/health`)).text()]).toEqual(["ok", "ok"]);
  });

  it("serving() tells whether the ready server still holds its port alone", async () => {
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

  it("a failing setup command stops everything and removes the worktree", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x") }]);
    const s = spec(repo.path, repo.shas[0]!, { setup: [["/bin/sh", "-c", "echo boom >&2; exit 7"]] });
    const err = await startError(s);
    expect(err.message).toContain("setup command 0 (/bin/sh) did not succeed: exit 7");
    expect(verificationErrorCheck(err).name).toBe("complete browser verification");
    expect(err.logTail).toContain("boom");
    expect(err.teardown).toMatchObject({ removed: true, quarantineReasons: [] });
    expect(readdirSync(previews())).toEqual([]);
  });

  it("a setup timeout with a clean teardown allows verification to retry", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x") }]);
    const s = spec(repo.path, repo.shas[0]!, {setup: [["/bin/sleep", "20"]]});
    const err = await startError({...s, setupTimeoutMs: 100});
    expect(err.message).toContain("timed_out");
    expect(verificationErrorCheck(err).name).toBe("verification infrastructure");
    expect(err.teardown).toMatchObject({removed: true, noKnownSurvivors: true});
  });

  it("a setup command that leaves a detached process fails the preview, and the process is killed", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x") }]);
    const err = await startError(spec(repo.path, repo.shas[0]!, { setup: [DETACH] }));
    const leftovers = reportedLeftovers(err.message);
    expect(leftovers.length).toBe(1);
    expect(await allGone(leftovers)).toBe(true);
    expect(err.teardown?.removed).toBe(true);
  });

  it("a process the preview detached from its group is found and killed at teardown, and the worktree is kept", async () => {
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

  it("a preview that never answers 200 is torn down after the bound", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x", { healthStatus: 503 }) }]);
    const t0 = Date.now();
    const err = await startError(spec(repo.path, repo.shas[0]!));
    expect(verificationErrorCheck(err).name).toBe("verification infrastructure");
    expect(err.message).toContain("last probe: status 503");
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(err.teardown).toMatchObject({ noKnownSurvivors: true, removed: true });
    expect(readdirSync(previews())).toEqual([]);
  });

  it("a preview that exits is reported as exited, not waited out", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x", { exitCode: 3 }) }]);
    const t0 = Date.now();
    const err = await startError({ ...spec(repo.path, repo.shas[0]!), readyTimeoutMs: 10_000 });
    expect(verificationErrorCheck(err).name).toBe("preview starts");
    expect(err.message).toContain("the preview process exited");
    expect(Date.now() - t0).toBeLessThan(8_000);
  });

  it("refuses a ready path with a query or scheme", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x") }]);
    await expect(start(spec(repo.path, repo.shas[0]!, { readyPath: "http://x/" }))).rejects.toThrow("ready path");
  });

  it("a directory already present for the attempt is refused and left untouched", async () => {
    const repo = makeRepo(env.repos, "app", [{ "server.ts": serverSource("x") }]);
    const s = spec(repo.path, repo.shas[0]!);
    mkdirSync(join(previews(), s.id, "home"), { recursive: true, mode: 0o700 });
    writeFileSync(join(previews(), s.id, "home", "older"), "not this attempt's");
    await expect(start(s)).rejects.toThrow("already has a directory");
    expect(readFileSync(join(previews(), s.id, "home", "older"), "utf8")).toBe("not this attempt's");
  });

  it("the previews root must be private and outside every agent-writable root", () => {
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
  it("accepts the root's own listener and refuses a stranger's", async () => {
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

  it("refuses the root's own listener on any address but 127.0.0.1", () => {
    const me = { pid: process.pid, identity: null, exitedAt: () => null };
    const wide = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } });
    try {
      expect(listenerOwnership(env.config, wide.port, me)).toEqual({ ok: false, reason: `the preview listens on *:${wide.port}, beyond 127.0.0.1` });
    } finally {
      wide.stop(true);
    }
    // Loopback plus a second, wider listener on the same port is refused too.
    const loop = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const v6 = Bun.listen({ hostname: "::1", port: loop.port, socket: { data() {} } });
    try {
      expect(listenerOwnership(env.config, loop.port, me)).toEqual({ ok: false, reason: `the preview listens on [::1]:${loop.port}, beyond 127.0.0.1` });
    } finally {
      v6.stop(true);
      loop.stop(true);
    }
  });
});

describe("toolchainRoots", () => {
  it("requires existing roots outside agent-writable dirs that cover every tool dir", () => {
    expect(toolchainRoots([BUN_DIR, "/usr/bin"], [BUN_DIR], [env.repos])).toEqual([BUN_DIR]);
    expect(() => toolchainRoots([BUN_DIR], [], [])).toThrow(`tool dir ${BUN_DIR} is outside every toolchain root`);
    expect(() => toolchainRoots([BUN_DIR], [BUN_DIR], [BUN_DIR])).toThrow("is under agent-writable");
    expect(() => toolchainRoots([], ["/no/such/toolchain"], [])).toThrow("sandbox toolchain path does not exist: /no/such/toolchain");
  });
});

describe("bounded reads", () => {
  it("readiness needs only the status: an endless health body does not hold it up", async () => {
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

  it("tail reads only the end of a log, even one far larger than memory allows reading whole, from a line start", () => {
    const dir = join(env.stateRoot, "tail");
    mkdirSync(dir);
    const path = join(dir, "big.log");
    const fd = openSync(path, "w", 0o600);
    ftruncateSync(fd, 3 * 1024 ** 3); // sparse: no disk used
    writeSync(fd, "\nthe last line\n", 3 * 1024 ** 3);
    closeSync(fd);
    expect(tail(path, 50)).toBe("the last line\n");
    expect(tail(join(dir, "missing.log"))).toBe("");
    // A read that starts mid-line begins at the next whole line.
    writeFileSync(join(dir, "lines.log"), "DENIED /Users/someone/.ssh/config\nDENIED /x\nRESULT PASS\n");
    expect(tail(join(dir, "lines.log"), 30)).toBe("DENIED /x\nRESULT PASS\n");
    expect(tail(join(dir, "lines.log"), 1_000)).toBe("DENIED /Users/someone/.ssh/config\nDENIED /x\nRESULT PASS\n");
    // A last line longer than the window is never cut into: it is replaced by a note.
    writeFileSync(join(dir, "long.log"), `ok\n${"x".repeat(100)} /Users/someone/.codex/AGENTS.md\n`);
    expect(tail(join(dir, "long.log"), 30)).toBe("[factory: last line longer than 30 bytes, omitted]\n");
    writeFileSync(join(dir, "unended.log"), `ok\n${"x".repeat(100)} /Users/someone/.codex/AGENTS.md`);
    expect(tail(join(dir, "unended.log"), 30)).toBe("[factory: last line longer than 30 bytes, omitted]\n");
  });

  it("copyCapped keeps the first bytes, counts the rest, and closes the log when every pipe has closed", async () => {
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

test("scratch dependency setup sees the registry proxy only during setup and leaves the pinned checkout available", async () => {
  const scratch = join(env.home, "scratch");
  mkdirSync(scratch);
  const checkout = makeRepo(scratch, "repo", [{"source.txt": "pinned"}]);
  const id = crypto.randomUUID();
  await prepareAgentCheckout(env.config, {id, checkout: checkout.path, scratch, logDir: env.logDir,
    commands: {setup: [["/bin/sh", "-c", 'test -n "$HTTPS_PROXY" && echo prepared > setup-ran']], egress: ["registry.npmjs.org"]}});
  expect(readFileSync(join(checkout.path, "source.txt"), "utf8")).toBe("pinned");
  expect(readFileSync(join(checkout.path, "setup-ran"), "utf8")).toBe("prepared\n");
  expect(existsSync(join(scratch, "setup-home"))).toBe(false);
  expect(readdirSync(env.logDir).sort()).toEqual([id + ".scratch-egress.log", id + ".scratch-setup-0.log"]);
});

test("builder installs local tools before dispatch and runs both registered scripts without network", async () => {
  const checkout = makeRepo(env.repos, "builder", [{
    "package.json": JSON.stringify({ scripts: { lint: "local-check lint", typecheck: "local-check typecheck" } }),
  }]);
  const id = crypto.randomUUID();
  const dirs = createAttempt({ accountHome: env.home, stateRoot: env.stateRoot, runRoot: join(env.home, "runs"),
    project: checkout.path, attemptId: id, role: "builder", stage: "build" });
  const setup = [
    'test -n "$HTTPS_PROXY"',
    'if (echo changed > .git/setup-write) 2>/dev/null; then exit 1; fi',
    'mkdir -p node_modules/.bin',
    `printf '%s\\n' '#!/bin/sh' 'test -z "$HTTPS_PROXY" && echo "installed $1"' > node_modules/.bin/local-check`,
    'chmod +x node_modules/.bin/local-check',
  ].join("\n");
  await prepareAgentCheckout({...env.config, untrustedRoots: [...env.config.untrustedRoots, env.repos]}, {
    id, scratch: dirs.scratchDir, checkout: dirs.worktree, builderWorkspaceRoot: env.repos, logDir: env.logDir,
    commands: {setup: [["/bin/sh", "-ec", setup]], egress: []},
  });
  const cli = Bun.which("codex")!;
  const harnessHome = join(env.home, "codex-home");
  mkdirSync(harnessHome, {mode: 0o700});
  const deny = effectiveDenyRead({accountHome: env.home, stateRoot: env.stateRoot, harnessHomes: [harnessHome]});
  const policy = skillPolicy(dirs, deny, config.pilot.toolDirs, codexReadable(cli, deny), "/usr/bin/git");
  const childEnv = agentEnv({}, {harness: "codex", harnessHome, accountHome: env.home,
    trustedPath: [...config.pilot.toolDirs, "/usr/bin", "/bin"].join(":")});
  const run = (argv: readonly string[]) => Bun.spawnSync([cli, "sandbox", "-P", "factory", ...codexConfigArgs(policy), "--", ...argv],
    {cwd: dirs.worktree, env: childEnv, timeout: 10_000});
  for (const name of ["lint", "typecheck"] as const) {
    const result = run(config.pilot.commands[name]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("installed " + name);
  }
  expect(run(["/bin/sh", "-c", "echo x >node_modules/.bin/local-check"]).exitCode).not.toBe(0);
  expect(run(["/bin/cat", join(env.home, ".ssh/id_test")]).exitCode).not.toBe(0);
  const listener = Bun.listen({hostname: "127.0.0.1", port: 0, socket: {data() {}}});
  try {
    const result = run(["node", "-e", `require("net").connect(${listener.port},"127.0.0.1").on("connect",()=>process.exit(1)).on("error",e=>console.log(e.code))`]);
    expect(result.stdout.toString().trim()).toBe("EPERM");
  } finally { listener.stop(true); }
}, 30_000);
