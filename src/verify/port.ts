import { createHash } from "node:crypto";
import { createServer } from "node:net";
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

/**
 * The task's port: a stable starting point in the range derived from the task key, then the next free port after it,
 * wrapping around. The same task gets the same port while it is free, which keeps logs and evidence readable.
 * Freedom is only a hint (another process can bind in between); the preview's listener is verified after it is up.
 */
export async function taskPort(range: PortRange, key: string, isFree: (port: number) => Promise<boolean> = portIsFree): Promise<number> {
  const [low, high] = range;
  assertPort(low);
  assertPort(high);
  if (high < low) throw new Error(`empty port range ${low}-${high}`);
  const size = high - low + 1;
  const start = createHash("sha256").update(key).digest().readUInt32BE(0) % size;
  for (let i = 0; i < size; i++) {
    const port = low + ((start + i) % size);
    if (await isFree(port)) return port;
  }
  throw new Error(`no free port in ${low}-${high}`);
}

const LSOF_TIMEOUT_MS = 10_000;

/** Pids of this user's processes listening on TCP `port`, from `lsof` by absolute path with a fixed env, bounded. */
export function tcpListeners(lsofPath: string, port: number): number[] {
  assertPort(port);
  const r = Bun.spawnSync([lsofPath, "-w", "-n", "-P", "-a", "-u", String(process.getuid!()), `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "p"], {
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
  const pids = new Set<number>();
  for (const line of r.stdout.toString().split("\n")) if (/^p\d+$/.test(line)) pids.add(Number(line.slice(1)));
  return [...pids];
}
