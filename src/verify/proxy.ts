/**
 * The egress proxy of the setup phase: an HTTP CONNECT proxy on loopback that tunnels only to allowlisted hosts on 443.
 * Setup commands' Seatbelt profile allows outbound connections to the proxy's port and nowhere else.
 *
 * The ports are a pool the factory binds once and holds for its whole lifetime (`openEgressPool`), never released
 * between phases: the sandbox grants a port number, so a port given back could be taken by an unrelated listener that
 * a surviving install helper would then reach. Each phase gets a free pooled port and a fresh credential; ending the
 * phase closes its connections and revokes the credential, so a survivor that tries again reaches the factory's port
 * and is refused, whatever later phase runs there. The pool lives as long as the factory process: if the factory exits
 * while a survivor lives, the ports are released, and that attempt was already quarantined by the cleanup rule.
 *
 * Hosts are resolved by the factory, and only public addresses are dialed, so an allowlisted name that resolves to
 * loopback or a private network cannot reach the owner's local services.
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
  /** Ends the phase: closes its connections and revokes its credential; the port stays held. Idempotent. */
  stop(): EgressReport;
}

export interface EgressPool {
  /** The held ports, bound at open and never released before `close`. */
  readonly ports: readonly number[];
  /** Starts a setup phase on a free pooled port with a fresh credential; throws when every port has a phase. */
  startPhase(opts: EgressProxyOptions): EgressProxy;
  /** Connections refused because they came with no live phase or a credential other than the live one. */
  readonly refused: number;
  /** Releases the ports. The factory never calls it; tests do. */
  close(): void;
}

/** How many setup phases can run at once. */
export const EGRESS_POOL_SIZE = 4;

interface Phase {
  allow: Set<string>;
  upstream: Upstream;
  expected: Buffer;
  report: EgressReport;
  /** The phase's client and upstream sockets, all closed when it ends. */
  sockets: Set<Socket<unknown>>;
  stopped: boolean;
  log(line: string): void;
}

interface Slot {
  listener: TCPSocketListener<ClientState>;
  phase: Phase | null;
  /** Every client connected to the port, with or without a live phase. */
  clients: Set<Socket<ClientState>>;
}

interface ClientState {
  /** The phase live on the port when the client connected, or null. */
  phase: Phase | null;
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

export function openEgressPool(size = EGRESS_POOL_SIZE): EgressPool {
  if (!Number.isInteger(size) || size < 1) throw new Error(`egress pool size must be a positive integer: ${size}`);
  let refused = 0;
  const slots: Slot[] = [];

  const deny = (client: Socket<ClientState>, status: string, target: string, why: string) => {
    const phase = client.data.phase;
    if (phase) {
      phase.report.denied.push(target);
      phase.log(`DENY ${target} ${why}`);
    }
    if (status.startsWith("407")) refused++;
    client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const onHead = async (client: Socket<ClientState>, head: string, rest: Buffer) => {
    const phase = client.data.phase;
    const lines = head.split("\r\n");
    const m = /^CONNECT ([^\s:]+):(\d{1,5}) HTTP\/1\.[01]$/.exec(lines[0] ?? "");
    if (!m) return deny(client, "405 Method Not Allowed", "-", `not a CONNECT request: ${JSON.stringify((lines[0] ?? "").slice(0, 80))}`);
    const host = m[1]!.toLowerCase();
    const port = Number(m[2]);
    const target = `${host}:${port}`;
    // Without a live phase there is no credential to match: a survivor of an ended phase lands here.
    if (!phase || phase.stopped) return deny(client, "407 Proxy Authentication Required", target, "no live setup phase on this port");
    const auth = lines.slice(1).find((l) => /^proxy-authorization:/i.test(l))?.replace(/^[^:]*:\s*/, "") ?? "";
    const given = Buffer.from(auth);
    if (given.length !== phase.expected.length || !timingSafeEqual(given, phase.expected)) return deny(client, "407 Proxy Authentication Required", target, "missing or wrong phase credential");
    if (!phase.allow.has(host)) return deny(client, "403 Forbidden", target, "host not in the allowlist");
    if (port !== 443) return deny(client, "403 Forbidden", target, "only port 443 is allowed");
    let dial: { address: string; port: number };
    try {
      dial = await phase.upstream(host, port);
    } catch (err) {
      return deny(client, "502 Bad Gateway", target, (err as Error).message);
    }
    if (phase.stopped) return client.end();
    try {
      const up = await Bun.connect<UpstreamState>({
        hostname: dial.address,
        port: dial.port,
        data: { client, queue: [], queued: 0 },
        socket: {
          open(s) {
            phase.sockets.add(s);
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
            phase.sockets.delete(s);
            s.data.client.end();
          },
          error(s) {
            s.data.client.end();
          },
        },
      });
      if (phase.stopped) {
        up.end();
        return client.end();
      }
      client.data.upstream = up;
      phase.report.allowed.push(target);
      phase.log(`ALLOW ${target} via ${dial.address}`);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length > 0) send(up, up.data, rest);
    } catch (err) {
      deny(client, "502 Bad Gateway", target, `connect failed: ${(err as Error).message}`);
    }
  };

  const bind = (slot: Slot): TCPSocketListener<ClientState> =>
    Bun.listen<ClientState>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(client) {
          // Bounded per port whether or not a phase is live: a survivor knocking on an idle port cannot pile up sockets.
          if (slot.clients.size >= MAX_CONNECTIONS) return void client.end();
          slot.clients.add(client);
          const phase = slot.phase;
          const live = phase && !phase.stopped ? phase : null;
          live?.sockets.add(client);
          client.data = { phase: live, head: Buffer.alloc(0), upstream: null, queue: [], queued: 0, timer: setTimeout(() => client.end(), HEADER_TIMEOUT_MS) };
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
          slot.clients.delete(client);
          client.data?.phase?.sockets.delete(client);
          if (client.data?.timer) clearTimeout(client.data.timer);
          client.data?.upstream?.end();
        },
        error() {
          // close follows
        },
      },
    });

  for (let i = 0; i < size; i++) {
    const slot = { phase: null, clients: new Set() } as unknown as Slot;
    slot.listener = bind(slot);
    // Held for the factory's lifetime without keeping a finished process alive.
    slot.listener.unref();
    slots.push(slot);
  }

  return {
    ports: slots.map((s) => s.listener.port),
    get refused() {
      return refused;
    },
    startPhase(opts) {
      assertEgressHosts(opts.allow);
      const slot = slots.find((s) => s.phase === null);
      if (!slot) throw new Error(`every egress proxy port has a setup phase (${size} at once)`);
      const credential = randomBytes(24).toString("hex");
      const phase: Phase = {
        allow: new Set(opts.allow),
        upstream: opts.upstream ?? publicUpstream,
        expected: Buffer.from(`Basic ${Buffer.from(`factory:${credential}`).toString("base64")}`),
        report: { allowed: [], denied: [] },
        sockets: new Set(),
        stopped: false,
        log(line) {
          try {
            writeSync(opts.logFd, `${new Date().toISOString()} ${line}\n`);
          } catch {
            // A full or closed log must not take the proxy down mid-install.
          }
        },
      };
      slot.phase = phase;
      const port = slot.listener.port;
      phase.log(`LISTEN 127.0.0.1:${port} allow ${[...phase.allow].join(",") || "(none)"}`);
      return {
        port,
        url: `http://factory:${credential}@127.0.0.1:${port}`,
        stop() {
          if (!phase.stopped) {
            phase.stopped = true;
            // Every connection of the phase, client halves and tunnels alike; the port stays held for the next phase.
            for (const s of [...phase.sockets]) s.end();
            phase.sockets.clear();
            if (slot.phase === phase) slot.phase = null;
            phase.log(`STOP allowed ${phase.report.allowed.length} denied ${phase.report.denied.length}`);
          }
          return phase.report;
        },
      };
    },
    close() {
      for (const s of slots) {
        s.phase?.sockets.forEach((c) => c.end());
        s.phase = null;
        s.listener.stop(true);
      }
    },
  };
}
