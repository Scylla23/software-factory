/**
 * The egress proxy of the setup phase: an HTTP CONNECT proxy on loopback that tunnels only to allowlisted hosts on 443.
 * Setup commands' Seatbelt profile allows outbound connections to this proxy's port and nowhere else, so stopping the
 * proxy revokes egress for every process of the phase at once, including detached ones the sweeps cannot see.
 *
 * Each phase gets a fresh credential in the proxy URL, so a leftover process from another phase cannot use a later
 * proxy. Hosts are resolved by the factory, and only public addresses are dialed, so an allowlisted name that resolves
 * to loopback or a private network cannot reach the owner's local services.
 */
import type { Socket, TCPSocketListener } from "bun";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { writeSync } from "node:fs";

/** Package registries per stack; a project's egress allowlist starts from these. */
export const REGISTRY_HOSTS = {
  npm: ["registry.npmjs.org"],
  pypi: ["pypi.org", "files.pythonhosted.org"],
} as const;

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_HEADER = 8 * 1024;
const HEADER_TIMEOUT_MS = 10_000;
const MAX_QUEUED = 16 * 1024 * 1024;
const MAX_CONNECTIONS = 256;

export function assertEgressHosts(hosts: readonly string[]): void {
  for (const h of hosts) if (!HOST.test(h)) throw new Error(`egress host must be a lowercase DNS name without wildcards: ${JSON.stringify(h)}`);
}

/** Whether `ip` is a globally routable unicast address: not loopback, private, link-local, shared, or reserved. */
export function isPublicAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || ip.startsWith("192.0.0.") || ip.startsWith("192.0.2."))) return false;
    if (a === 198 && (b === 18 || b === 19 || ip.startsWith("198.51.100."))) return false;
    if (ip.startsWith("203.0.113.")) return false;
    return true;
  }
  if (isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (v === "::" || v === "::1" || v.startsWith("::ffff:") || v.startsWith("64:ff9b:")) return false;
    // Global unicast is 2000::/3; everything else (ULA fc00::/7, link-local fe80::/10, multicast ff00::/8) is not.
    if (!/^[23][0-9a-f]{0,3}:/.test(v)) return false;
    return !v.startsWith("2001:db8:") && !v.startsWith("2001:0db8:");
  }
  return false;
}

/** Where to dial for an allowed host: its first public address on `port`. Refuses a name with any non-public address. */
export type Upstream = (host: string, port: number) => Promise<{ address: string; port: number }>;

export const publicUpstream: Upstream = async (host, port) => {
  const addrs = await lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0) throw new Error("no address");
  const bad = addrs.find((a) => !isPublicAddress(a.address));
  if (bad) throw new Error(`resolves to non-public ${bad.address}`);
  return { address: addrs[0]!.address, port };
};

export interface EgressProxyOptions {
  /** Exact host names that may be tunnelled to, on port 443 only. */
  allow: readonly string[];
  /** The phase's private log; one line per decision, never a credential. */
  logFd: number;
  /** Seam for tests; the default resolves publicly and dials 443. */
  upstream?: Upstream;
}

export interface EgressReport {
  allowed: string[];
  denied: string[];
}

export interface EgressProxy {
  port: number;
  /** `http://factory:<credential>@127.0.0.1:<port>`, for HTTPS_PROXY. */
  url: string;
  /** Closes the listener and every open tunnel; idempotent. */
  stop(): EgressReport;
}

interface ClientState {
  head: Buffer;
  upstream: Socket<UpstreamState> | null;
  queue: Buffer[];
  queued: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface UpstreamState {
  client: Socket<ClientState>;
  queue: Buffer[];
  queued: number;
}

type Queued = { queue: Buffer[]; queued: number };

/** Writes `data` to `to`, queueing what the socket did not take; false when the queue would pass its bound. */
function send(to: Socket<unknown>, q: Queued, data: Buffer): boolean {
  if (q.queue.length === 0) {
    const n = to.write(data);
    if (n === data.length) return true;
    data = data.subarray(Math.max(0, n));
  }
  q.queue.push(data);
  q.queued += data.length;
  return q.queued <= MAX_QUEUED;
}

function flush(to: Socket<unknown>, q: Queued): void {
  while (q.queue.length > 0) {
    const head = q.queue[0]!;
    const n = to.write(head);
    q.queued -= Math.max(0, n);
    if (n < head.length) {
      q.queue[0] = head.subarray(Math.max(0, n));
      return;
    }
    q.queue.shift();
  }
}

export function startEgressProxy(opts: EgressProxyOptions): EgressProxy {
  assertEgressHosts(opts.allow);
  const allow = new Set(opts.allow);
  const upstream = opts.upstream ?? publicUpstream;
  const credential = randomBytes(24).toString("hex");
  const expected = Buffer.from(`Basic ${Buffer.from(`factory:${credential}`).toString("base64")}`);
  const report: EgressReport = { allowed: [], denied: [] };
  const sockets = new Set<Socket<unknown>>();
  let stopped = false;
  const log = (line: string) => {
    try {
      writeSync(opts.logFd, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // A full or closed log must not take the proxy down mid-install.
    }
  };
  const deny = (client: Socket<ClientState>, status: string, target: string, why: string) => {
    report.denied.push(target);
    log(`DENY ${target} ${why}`);
    client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const onHead = async (client: Socket<ClientState>, head: string, rest: Buffer) => {
    const lines = head.split("\r\n");
    const m = /^CONNECT ([^\s:]+):(\d{1,5}) HTTP\/1\.[01]$/.exec(lines[0] ?? "");
    if (!m) return deny(client, "405 Method Not Allowed", "-", `not a CONNECT request: ${JSON.stringify((lines[0] ?? "").slice(0, 80))}`);
    const host = m[1]!.toLowerCase();
    const port = Number(m[2]);
    const target = `${host}:${port}`;
    const auth = lines.slice(1).find((l) => /^proxy-authorization:/i.test(l))?.replace(/^[^:]*:\s*/, "") ?? "";
    const given = Buffer.from(auth);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return deny(client, "407 Proxy Authentication Required", target, "missing or wrong phase credential");
    if (!allow.has(host)) return deny(client, "403 Forbidden", target, "host not in the allowlist");
    if (port !== 443) return deny(client, "403 Forbidden", target, "only port 443 is allowed");
    let dial: { address: string; port: number };
    try {
      dial = await upstream(host, port);
    } catch (err) {
      return deny(client, "502 Bad Gateway", target, (err as Error).message);
    }
    if (stopped) return client.end();
    try {
      const up = await Bun.connect<UpstreamState>({
        hostname: dial.address,
        port: dial.port,
        data: { client, queue: [], queued: 0 },
        socket: {
          open(s) {
            sockets.add(s);
          },
          data(s, data) {
            if (!send(s.data.client, s.data.client.data, Buffer.from(data))) {
              s.data.client.end();
              s.end();
            }
          },
          drain(s) {
            flush(s, s.data);
          },
          close(s) {
            sockets.delete(s);
            s.data.client.end();
          },
          error(s) {
            s.data.client.end();
          },
        },
      });
      if (stopped) {
        up.end();
        return client.end();
      }
      client.data.upstream = up;
      report.allowed.push(target);
      log(`ALLOW ${target} via ${dial.address}`);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length > 0) send(up, up.data, rest);
    } catch (err) {
      deny(client, "502 Bad Gateway", target, `connect failed: ${(err as Error).message}`);
    }
  };

  const listener: TCPSocketListener<ClientState> = Bun.listen<ClientState>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(client) {
        if (stopped || sockets.size >= MAX_CONNECTIONS) return void client.end();
        sockets.add(client);
        client.data = { head: Buffer.alloc(0), upstream: null, queue: [], queued: 0, timer: setTimeout(() => client.end(), HEADER_TIMEOUT_MS) };
      },
      data(client, data) {
        const st = client.data;
        if (st.upstream) {
          if (!send(st.upstream, st.upstream.data, Buffer.from(data))) {
            st.upstream.end();
            client.end();
          }
          return;
        }
        if (st.timer === null) return; // the head is being handled; nothing may arrive before the 200
        st.head = Buffer.concat([st.head, Buffer.from(data)]);
        const end = st.head.indexOf("\r\n\r\n");
        if (end < 0) {
          if (st.head.length > MAX_HEADER) deny(client, "431 Request Header Fields Too Large", "-", "header too large");
          return;
        }
        clearTimeout(st.timer);
        st.timer = null;
        void onHead(client, st.head.subarray(0, end).toString("latin1"), st.head.subarray(end + 4));
      },
      drain(client) {
        flush(client, client.data);
      },
      close(client) {
        sockets.delete(client);
        if (client.data?.timer) clearTimeout(client.data.timer);
        client.data?.upstream?.end();
      },
      error() {
        // close follows
      },
    },
  });
  const port = listener.port;
  log(`LISTEN 127.0.0.1:${port} allow ${[...allow].join(",") || "(none)"}`);
  return {
    port,
    url: `http://factory:${credential}@127.0.0.1:${port}`,
    stop() {
      if (!stopped) {
        stopped = true;
        // Closes every client connection; each client's close handler ends its upstream half.
        listener.stop(true);
        log(`STOP allowed ${report.allowed.length} denied ${report.denied.length}`);
      }
      return report;
    },
  };
}
