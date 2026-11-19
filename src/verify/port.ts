import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { assertPrivateDir } from "../dispatch/config";
import { type ProcIdentity, snapshot } from "../dispatch/process";
import { assertPort } from "./sandbox";

export type PortRange = readonly [low: number, high: number];

/** Whether nothing listens on 127.0.0.1:`port`, by binding it briefly. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** The range's ports in the task's order: a stable start derived from the task key, then upwards, wrapping around. */
export function taskOrder(range: PortRange, key: string): number[] {
  const [low, high] = range;
  assertPort(low);
  assertPort(high);
  if (high < low) throw new Error(`empty port range ${low}-${high}`);
  const size = high - low + 1;
  const start = createHash("sha256").update(key).digest().readUInt32BE(0) % size;
  return Array.from({ length: size }, (_, i) => low + ((start + i) % size));
}

/**
 * The task's port: the first free one in the task's order. The same task gets the same port while it is free, which
 * keeps logs and evidence readable. Freedom is only a hint; see `leasePort` for what makes a choice hold.
 */
export async function taskPort(range: PortRange, key: string, isFree: (port: number) => Promise<boolean> = portIsFree): Promise<number> {
  for (const port of taskOrder(range, key)) if (await isFree(port)) return port;
  throw new Error(`no free port in ${range[0]}-${range[1]}`);
}

export interface PortLease {
  port: number;
  /** Removes the lease file if it is still this lease's; idempotent. */
  release(): void;
}

export interface LeaseOptions {
  /** `<state root>/ports`; created private if missing. */
  dir: string;
  stateRoot: string;
  psPath: string;
  /** Who holds it, for the owner reading the lease directory. */
  attempt: string;
  isFree?: (port: number) => Promise<boolean>;
}

interface LeaseBody {
  pid: number;
  start: string;
  attempt: string;
}

let self: ProcIdentity | null = null;

function selfIdentity(psPath: string): ProcIdentity {
  if (!self) {
    const row = snapshot(psPath, [process.pid]).get(process.pid);
    if (!row) throw new Error("cannot read this process's own start time");
    self = { pid: row.pid, start: row.start };
  }
  return self;
}

function readLease(path: string): { raw: string; body: LeaseBody | null } | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const b = JSON.parse(raw) as LeaseBody;
    if (typeof b?.pid === "number" && typeof b.start === "string" && typeof b.attempt === "string") return { raw, body: b };
  } catch {
    // malformed
  }
  return { raw, body: null };
}

/** Whether the lease's holder, by pid and start time, is still running; a recycled pid is not its holder. */
function holderAlive(body: LeaseBody, psPath: string): boolean {
  return snapshot(psPath, [body.pid]).get(body.pid)?.start === body.start;
}

/**
 * Leases the task's port across every preview start of every factory process on this machine: one lease file per port
 * under the state root, created complete and exclusively (written to a private temp name, then hard-linked into place,
 * which fails if any lease exists). A lease whose holder process is gone is reclaimed.
 *
 * The lease keeps starts from choosing the same port; it cannot keep an unrelated process from binding it. The preview
 * still verifies its listener, and a start that loses the bind retries on the next port (see `startPreview`). That same
 * check covers the one race leasing leaves: two factories reclaiming one stale lease at the same instant.
 */
export async function leasePort(range: PortRange, key: string, opts: LeaseOptions): Promise<PortLease> {
  const order = taskOrder(range, key);
  try {
    mkdirSync(opts.dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const dir = assertPrivateDir(opts.dir, opts.stateRoot);
  const me = selfIdentity(opts.psPath);
  const body = JSON.stringify({ pid: me.pid, start: me.start, attempt: opts.attempt } satisfies LeaseBody);
  const isFree = opts.isFree ?? portIsFree;
  for (const port of order) {
    const path = join(dir, `${port}.lease`);
    if (!take(dir, path, body)) {
      const held = readLease(path);
      // A malformed lease is never reclaimed: nothing this module writes is malformed, so it is not ours to remove.
      if (!held?.body || holderAlive(held.body, opts.psPath)) continue;
      // The liveness check spawns `ps`, and Bun.spawnSync runs other callbacks while it waits, so another start in this
      // process may have reclaimed the lease meanwhile: remove only the very lease that was judged stale.
      if (readLease(path)?.raw !== held.raw) continue;
      try {
        unlinkSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (!take(dir, path, body)) continue;
    }
    const lease = { port, release: () => releaseLease(path, body) };
    if (await isFree(port)) return lease;
    lease.release();
  }
  throw new Error(`no free, unleased port in ${range[0]}-${range[1]}`);
}

/** Creates `path` holding `body`, complete, only if nothing is there. */
function take(dir: string, path: string, body: string): boolean {
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    unlinkSync(tmp);
  }
}

function releaseLease(path: string, body: string): void {
  let current: string;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    return;
  }
  // Reclaimed by someone else after this holder was judged dead: not ours any more.
  if (current !== body) return;
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

const LSOF_TIMEOUT_MS = 10_000;

/** This user's listeners on TCP `port`, each a pid and the address it listens on as lsof prints it (`127.0.0.1:4100`,
 * `*:4100`, `[::1]:4100`), from `lsof` by absolute path with a fixed env, bounded. */
export function tcpListeners(lsofPath: string, port: number): { pid: number; address: string }[] {
  assertPort(port);
  const r = Bun.spawnSync([lsofPath, "-w", "-n", "-P", "-a", "-u", String(process.getuid!()), `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pn"], {
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: LSOF_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (r.exitedDueToTimeout) throw new Error(`lsof gave no answer within ${LSOF_TIMEOUT_MS}ms`);
  // lsof exits 1 when nothing matches.
  if (r.exitCode !== 0 && !(r.exitCode === 1 && r.stdout.length === 0)) throw new Error(`lsof exited ${r.exitCode}: ${r.stderr.toString().trim().slice(0, 200)}`);
  const found: { pid: number; address: string }[] = [];
  let pid: number | null = null;
  for (const line of r.stdout.toString().split("\n")) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) found.push({ pid, address: line.slice(1) });
  }
  return found;
}
