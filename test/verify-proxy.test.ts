import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEgressHosts, type EgressProxy, isPublicAddress, publicUpstream, startEgressProxy } from "../src/verify/proxy";

let dir: string;
let logPath: string;
let logFd: number;
let registry: ReturnType<typeof Bun.serve>;
let proxy: EgressProxy | null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-proxy-"));
  logPath = join(dir, "egress.log");
  logFd = openSync(logPath, "wx", 0o600);
  // Stands in for a registry: the tunnel carries plain HTTP to it, so no TLS is needed in tests.
  registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new Response(`registry ${new URL(req.url).pathname}`) });
  proxy = null;
});
afterEach(() => {
  proxy?.stop();
  registry.stop(true);
  closeSync(logFd);
  rmSync(dir, { recursive: true, force: true });
});

function start(allow: readonly string[] = ["registry.test"]): EgressProxy {
  proxy = startEgressProxy({ allow, logFd, upstream: async () => ({ address: "127.0.0.1", port: registry.port! }) });
  return proxy;
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

  test("stopping revokes egress: both halves of an open tunnel close and the port refuses new connections", async () => {
    const upstreamClosed = Promise.withResolvers<void>();
    const upstreamOpen = Promise.withResolvers<void>();
    const raw = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: () => upstreamOpen.resolve(), data() {}, close: () => upstreamClosed.resolve() } });
    proxy = startEgressProxy({ allow: ["registry.test"], logFd, upstream: async () => ({ address: "127.0.0.1", port: raw.port }) });
    const p = proxy;
    try {
      const clientClosed = Promise.withResolvers<void>();
      const s = await Bun.connect({ hostname: "127.0.0.1", port: p.port, socket: { data() {}, close: () => clientClosed.resolve() } });
      const auth = Buffer.from(`factory:${new URL(p.url).password}`).toString("base64");
      s.write(`CONNECT registry.test:443 HTTP/1.1\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
      await upstreamOpen.promise;
      p.stop();
      await clientClosed.promise;
      await upstreamClosed.promise;
      expect((await viaProxy(p.url, "http://registry.test:443/x")).connect).toBe("000");
    } finally {
      raw.stop(true);
    }
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
  });
});
