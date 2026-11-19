import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEgressHosts, type EgressPool, type EgressProxy, isPublicAddress, openEgressPool, publicUpstream } from "../src/verify/proxy";

let dir: string;
let logPath: string;
let logFd: number;
let registry: ReturnType<typeof Bun.serve>;
let pool: EgressPool;
let phases: EgressProxy[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-proxy-"));
  logPath = join(dir, "egress.log");
  logFd = openSync(logPath, "wx", 0o600);
  // Stands in for a registry: the tunnel carries plain HTTP to it, so no TLS is needed in tests.
  registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new Response(`registry ${new URL(req.url).pathname}`) });
  pool = openEgressPool(2);
  phases = [];
});
afterEach(() => {
  for (const p of phases) p.stop();
  pool.close();
  registry.stop(true);
  closeSync(logFd);
  rmSync(dir, { recursive: true, force: true });
});

function start(allow: readonly string[] = ["registry.test"], upstreamPort?: number): EgressProxy {
  const p = pool.startPhase({ allow, logFd, upstream: async () => ({ address: "127.0.0.1", port: upstreamPort ?? registry.port! }) });
  phases.push(p);
  return p;
}

/** curl through the proxy with a CONNECT tunnel; returns the CONNECT status, the HTTP status, and the body. */
async function viaProxy(proxyUrl: string, target: string): Promise<{ connect: string; code: string; body: string }> {
  const p = Bun.spawn(["/usr/bin/curl", "-sS", "-m", "5", "-p", "-x", proxyUrl, "-o", "-", "-w", "\n%{http_connect} %{http_code}", target], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const nl = out.lastIndexOf("\n");
  const [connect = "", code = ""] = out.slice(nl + 1).split(" ");
  return { connect, code, body: out.slice(0, nl) };
}

const withCredential = (url: string, cred: string | null) => {
  const u = new URL(url);
  u.username = cred === null ? "" : "factory";
  u.password = cred ?? "";
  return u.toString().replace(/\/$/, "");
};

/** `promise`, or a rejection naming `what` after `ms`, so a test that waits on a socket fails instead of hanging. */
function within<T>(promise: Promise<T>, what: string, ms = 3_000): Promise<T> {
  return Promise.race([promise, Bun.sleep(ms).then(() => Promise.reject(new Error(`${what}: not within ${ms}ms`)))]);
}

/** The error code of binding 127.0.0.1:`port` as an unrelated process would, or "BOUND". */
function bindAsStranger(port: number): string {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return "BOUND";
  } catch (err) {
    return String((err as NodeJS.ErrnoException).code);
  }
}

describe("egress proxy", () => {
  test("tunnels to an allowlisted host on 443 and logs it", async () => {
    const p = start();
    const r = await viaProxy(p.url, "http://registry.test:443/pkg");
    expect(r).toEqual({ connect: "200", code: "200", body: "registry /pkg" });
    expect(p.stop()).toEqual({ allowed: ["registry.test:443"], denied: [] });
    expect(readFileSync(logPath, "utf8")).toContain("ALLOW registry.test:443 via 127.0.0.1");
  });

  test("refuses a host outside the allowlist, another port, a missing or wrong credential, and plain requests", async () => {
    const p = start();
    expect((await viaProxy(p.url, "http://evil.example:443/x")).connect).toBe("403");
    expect((await viaProxy(p.url, "http://registry.test:8443/x")).connect).toBe("403");
    expect((await viaProxy(withCredential(p.url, null), "http://registry.test:443/x")).connect).toBe("407");
    expect((await viaProxy(withCredential(p.url, "guess"), "http://registry.test:443/x")).connect).toBe("407");
    const plain = Bun.spawn(["/usr/bin/curl", "-s", "-m", "5", "-x", p.url, "-o", "/dev/null", "-w", "%{http_code}", "http://registry.test/x"], { stdout: "pipe" });
    expect(await new Response(plain.stdout).text()).toBe("405");
    const report = p.stop();
    expect(report.allowed).toEqual([]);
    expect(report.denied).toEqual(["evil.example:443", "registry.test:8443", "registry.test:443", "registry.test:443", "-"]);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("DENY evil.example:443 host not in the allowlist");
    expect(log).toContain("DENY registry.test:443 missing or wrong phase credential");
    expect(log).not.toContain(new URL(p.url).password);
  });

  test("closes a request whose head never ends within the size bound", async () => {
    const p = start();
    const reply = Promise.withResolvers<string>();
    let got = "";
    const s = await Bun.connect({ hostname: "127.0.0.1", port: p.port, socket: { data: (_s, d) => void (got += Buffer.from(d).toString()), close: () => reply.resolve(got) } });
    s.write(`CONNECT registry.test:443 HTTP/1.1\r\nX-Pad: ${"a".repeat(9000)}`);
    expect(await reply.promise).toStartWith("HTTP/1.1 431");
  });

  test("ending a phase revokes its egress: both halves of an open tunnel close, and the held port refuses the old credential", async () => {
    const upstreamClosed = Promise.withResolvers<void>();
    const upstreamOpen = Promise.withResolvers<void>();
    const raw = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: () => upstreamOpen.resolve(), data() {}, close: () => upstreamClosed.resolve() } });
    const p = start(["registry.test"], raw.port);
    try {
      const clientClosed = Promise.withResolvers<void>();
      const s = await Bun.connect({ hostname: "127.0.0.1", port: p.port, socket: { data() {}, close: () => clientClosed.resolve() } });
      const auth = Buffer.from(`factory:${new URL(p.url).password}`).toString("base64");
      s.write(`CONNECT registry.test:443 HTTP/1.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
      await within(upstreamOpen.promise, "tunnel open");
      p.stop();
      await within(clientClosed.promise, "client half closed");
      await within(upstreamClosed.promise, "upstream half closed");
      expect((await viaProxy(p.url, "http://registry.test:443/x")).connect).toBe("407");
      expect(pool.refused).toBe(1);
    } finally {
      raw.stop(true);
    }
  });

  test("a CONNECT still being resolved when its phase ends is never dialed or tunneled", async () => {
    const gate = Promise.withResolvers<void>();
    const asked = Promise.withResolvers<void>();
    let dialed = 0;
    const raw = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: () => void dialed++, data() {} } });
    const p = pool.startPhase({
      allow: ["registry.test"],
      logFd,
      upstream: async () => {
        asked.resolve();
        await gate.promise;
        return { address: "127.0.0.1", port: raw.port };
      },
    });
    phases.push(p);
    let got = "";
    const closed = Promise.withResolvers<void>();
    const s = await Bun.connect({ hostname: "127.0.0.1", port: p.port, socket: { data: (_s, d) => void (got += Buffer.from(d).toString()), close: () => closed.resolve() } });
    s.write(`CONNECT registry.test:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`factory:${new URL(p.url).password}`).toString("base64")}\r\n\r\n`);
    await within(asked.promise, "upstream asked");
    expect(p.stop()).toEqual({ allowed: [], denied: [] });
    gate.resolve();
    await within(closed.promise, "client closed");
    await Bun.sleep(100);
    raw.stop(true);
    expect(dialed).toBe(0);
    expect(got).toBe("");
    expect(p.stop().allowed).toEqual([]);
    expect(readFileSync(logPath, "utf8")).not.toContain("ALLOW");
  });

  test("the ports stay held between phases: a stranger cannot bind one, and a new phase there takes only its own credential", async () => {
    const first = start();
    expect(pool.ports).toContain(first.port);
    expect((await viaProxy(first.url, "http://registry.test:443/a")).connect).toBe("200");
    first.stop();
    // No phase is live; the port is still the factory's.
    expect(bindAsStranger(first.port)).toBe("EADDRINUSE");
    expect((await viaProxy(first.url, "http://registry.test:443/b")).connect).toBe("407");
    const second = start();
    expect(second.port).toBe(first.port);
    expect(second.url).not.toBe(first.url);
    expect((await viaProxy(second.url, "http://registry.test:443/c")).connect).toBe("200");
    expect((await viaProxy(first.url, "http://registry.test:443/d")).connect).toBe("407");
    expect(second.stop()).toEqual({ allowed: ["registry.test:443"], denied: ["registry.test:443"] });
    expect(bindAsStranger(first.port)).toBe("EADDRINUSE");
    expect(readFileSync(logPath, "utf8")).toContain("DENY registry.test:443 missing or wrong phase credential");
    expect(pool.refused).toBe(2);
  });

  test("phases at once get different ports; the pool refuses one more instead of opening a port", () => {
    const a = start();
    const b = start();
    expect(new Set([a.port, b.port]).size).toBe(2);
    expect(() => start()).toThrow("every egress proxy port has a setup phase (2 at once)");
    expect(pool.ports).toHaveLength(2);
    b.stop();
    expect(start().port).toBe(b.port);
  });

  test("connections to a port with no live phase are bounded too", async () => {
    const port = start().port;
    phases[0]!.stop();
    const closed: Promise<void>[] = [];
    const sockets = [];
    for (let i = 0; i < 300; i++) {
      const c = Promise.withResolvers<void>();
      closed.push(c.promise);
      sockets.push(await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, close: () => c.resolve() } }));
    }
    // Past the bound the pool closes new connections at once; the others wait for their head.
    const early = await Promise.race([Promise.all(closed.slice(256)).then(() => "closed"), Bun.sleep(2_000).then(() => "open")]);
    for (const s of sockets) s.end();
    expect(early).toBe("closed");
  });

  test("the held ports do not keep a finished factory process alive", async () => {
    const src = join(import.meta.dir, "..", "src", "verify", "proxy.ts");
    const p = Bun.spawn([process.execPath, "-e", `const { openEgressPool } = await import(${JSON.stringify(src)}); openEgressPool(); console.log("opened");`], { stdout: "pipe", stderr: "ignore", timeout: 4_000, killSignal: "SIGKILL" });
    expect(await new Response(p.stdout).text()).toBe("opened\n");
    expect(await p.exited).toBe(0);
    expect(p.signalCode).toBeNull();
  });

  test("closing the pool releases its ports", () => {
    const own = openEgressPool(1);
    const port = own.ports[0]!;
    expect(bindAsStranger(port)).toBe("EADDRINUSE");
    own.close();
    expect(bindAsStranger(port)).toBe("BOUND");
  });

  test("an allowlisted name that resolves to loopback or a private network is never dialed", async () => {
    await expect(publicUpstream("localhost", 443)).rejects.toThrow("resolves to non-public");
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "64:ff9b::10.0.0.1", "2001:db8::1"]) {
      expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
    }
    for (const ip of ["104.16.0.1", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"]) expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
  });

  test("the allowlist takes exact lowercase names only", () => {
    expect(() => assertEgressHosts(["*.npmjs.org"])).toThrow("without wildcards");
    expect(() => assertEgressHosts(["Registry.npmjs.org"])).toThrow("lowercase");
    expect(() => assertEgressHosts(["localhost"])).toThrow();
    expect(() => assertEgressHosts(["registry.npmjs.org", "files.pythonhosted.org"])).not.toThrow();
    expect(() => openEgressPool(0)).toThrow("positive integer");
  });
});
