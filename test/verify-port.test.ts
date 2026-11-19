import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leasePort, portIsFree, taskOrder, taskPort, tcpListeners } from "../src/verify/port";

describe("taskPort", () => {
  test("is stable per task key and stays in range", async () => {
    const a = await taskPort([4100, 4199], "task-a", async () => true);
    expect(await taskPort([4100, 4199], "task-a", async () => true)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(4100);
    expect(a).toBeLessThanOrEqual(4199);
    const spread = new Set(await Promise.all(["a", "b", "c", "d", "e", "f"].map((k) => taskPort([4100, 4199], k, async () => true))));
    expect(spread.size).toBeGreaterThan(1);
  });

  test("skips busy ports, wraps around the range, and fails when none is free", async () => {
    const first = await taskPort([5000, 5003], "k", async () => true);
    const busy = new Set([first, first === 5003 ? 5000 : first + 1]);
    const next = await taskPort([5000, 5003], "k", async (p) => !busy.has(p));
    expect(next).toBe(first + 2 > 5003 ? first + 2 - 4 : first + 2);
    await expect(taskPort([5000, 5003], "k", async () => false)).rejects.toThrow("no free port in 5000-5003");
    await expect(taskPort([5003, 5000], "k")).rejects.toThrow("empty port range");
    await expect(taskPort([80, 90], "k")).rejects.toThrow("1024-65535");
  });
});

describe("port probes", () => {
  test("portIsFree and tcpListeners see a real listener and its pid", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = server.port!;
    try {
      expect(await portIsFree(port)).toBe(false);
      expect(tcpListeners("/usr/sbin/lsof", port)).toEqual([process.pid]);
    } finally {
      server.stop(true);
    }
    expect(await portIsFree(port)).toBe(true);
    expect(tcpListeners("/usr/sbin/lsof", port)).toEqual([]);
  });
});

describe("leasePort", () => {
  let state: string;
  let dir: string;
  const free = async () => true;
  const opts = (extra: Partial<Parameters<typeof leasePort>[2]> = {}) => ({ dir, stateRoot: state, psPath: "/bin/ps", attempt: "a1", isFree: free, ...extra });
  const RANGE = [6000, 6003] as const;
  const first = taskOrder(RANGE, "k")[0]!;
  const second = taskOrder(RANGE, "k")[1]!;
  beforeEach(() => {
    state = realpathSync(mkdtempSync(join(tmpdir(), "verify-lease-")));
    dir = join(state, "ports");
  });
  afterEach(() => rmSync(state, { recursive: true, force: true }));

  test("a held lease sends the next start with the same key to the next port, and release gives it back", async () => {
    const a = await leasePort(RANGE, "k", opts());
    const b = await leasePort(RANGE, "k", opts({ attempt: "a2" }));
    expect([a.port, b.port]).toEqual([first, second]);
    expect(JSON.parse(readFileSync(join(dir, `${first}.lease`), "utf8"))).toMatchObject({ pid: process.pid, attempt: "a1" });
    a.release();
    a.release();
    expect(existsSync(join(dir, `${first}.lease`))).toBe(false);
    expect((await leasePort(RANGE, "k", opts({ attempt: "a3" }))).port).toBe(first);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("leases whose holder is gone, or whose pid now belongs to another process, are reclaimed; live and malformed ones are not", async () => {
    const dead = Bun.spawn(["/usr/bin/true"]);
    await dead.exited;
    const write = (port: number, body: string) => writeFileSync(join(dir, `${port}.lease`), body, { mode: 0o600 });
    (await leasePort(RANGE, "k", opts())).release(); // creates the dir
    write(first, JSON.stringify({ pid: dead.pid, start: "Mon Jan  1 00:00:00 2001", attempt: "gone" }));
    expect((await leasePort(RANGE, "k", opts())).port).toBe(first);
    expect(JSON.parse(readFileSync(join(dir, `${first}.lease`), "utf8")).attempt).toBe("a1");

    rmSync(join(dir, `${first}.lease`));
    write(first, JSON.stringify({ pid: process.pid, start: "Mon Jan  1 00:00:00 2001", attempt: "recycled" }));
    expect((await leasePort(RANGE, "k", opts())).port).toBe(first);

    rmSync(join(dir, `${first}.lease`));
    write(first, "not json");
    expect((await leasePort(RANGE, "k", opts())).port).toBe(second);
    expect(readFileSync(join(dir, `${first}.lease`), "utf8")).toBe("not json");
  });

  test("a start that reclaims a stale lease while another start's liveness check waits is not undone by it", async () => {
    (await leasePort(RANGE, "k", opts())).release();
    writeFileSync(join(dir, `${first}.lease`), JSON.stringify({ pid: process.pid, start: "Mon Jan  1 00:00:00 2001", attempt: "stale" }), { mode: 0o600 });
    // b is queued before a starts, so it runs inside a's liveness check: Bun.spawnSync runs callbacks while it waits.
    const b = Bun.sleep(1).then(() => leasePort(RANGE, "k", opts({ attempt: "b" })));
    const t = Date.now();
    while (Date.now() - t < 5) {} // lets b's timer come due, so the first nested wait runs it
    const a = await leasePort(RANGE, "k", opts({ attempt: "a" }));
    const [pa, pb] = [a.port, (await b).port];
    expect(new Set([pa, pb]).size).toBe(2);
    expect(JSON.parse(readFileSync(join(dir, `${first}.lease`), "utf8")).attempt).toBe(pa === first ? "a" : "b");
  });

  test("release leaves a lease that another start reclaimed in the meantime", async () => {
    const a = await leasePort(RANGE, "k", opts());
    writeFileSync(join(dir, `${a.port}.lease`), JSON.stringify({ pid: 1, start: "x", attempt: "other" }));
    a.release();
    expect(existsSync(join(dir, `${a.port}.lease`))).toBe(true);
  });

  test("a leased port that something already listens on is given back and skipped", async () => {
    const busy = await leasePort(RANGE, "k", opts({ isFree: async (p) => p !== first }));
    expect(busy.port).toBe(second);
    expect(existsSync(join(dir, `${first}.lease`))).toBe(false);
    await expect(leasePort(RANGE, "k", opts({ isFree: async () => false }))).rejects.toThrow("no free, unleased port in 6000-6003");
  });

  test("the lease directory must be private", async () => {
    (await leasePort(RANGE, "k", opts())).release();
    chmodSync(dir, 0o755);
    await expect(leasePort(RANGE, "k", opts())).rejects.toThrow("accessible to group or others");
  });
});
