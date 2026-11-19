import { describe, expect, test } from "bun:test";
import { taskPort, tcpListeners, portIsFree } from "../src/verify/port";

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
