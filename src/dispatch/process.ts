/**
 * Agent process lifecycle.
 *
 * Both CLIs run tool commands in their own process groups.
 * On SIGTERM Claude reaps them but Codex leaves them orphaned, and on SIGKILL both do.
 * So the CLI is spawned as its own session and process-group leader, and termination freezes the tree,
 * signals every tracked process by identity, then the whole group.
 *
 * A process is identified by (pid, start time) from `ps`, and re-verified against a fresh snapshot
 * before every signal, so a recycled pid is never signalled.
 * macOS has no cgroups, so one gap remains: a tool that calls setsid() and whose parent exits
 * before the first snapshot is reparented to launchd outside our group and is not found.
 */
import { spawn } from "node:child_process";

export interface ProcIdentity {
  pid: number;
  /** `ps` lstart in UTC, one-second resolution. */
  start: string;
}

export interface ProcRow extends ProcIdentity {
  ppid: number;
  pgid: number;
  zombie: boolean;
}

export type Snapshot = Map<number, ProcRow>;

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/;

/** All processes, or the given pids. Runs `ps` by absolute path with a minimal, fixed env. */
export function snapshot(psPath: string, pids?: readonly number[]): Snapshot {
  const select = pids ? ["-p", pids.join(",")] : ["-A"];
  const ps = Bun.spawnSync([psPath, ...select, "-o", "pid=,ppid=,pgid=,stat=,lstart="], {
    // TZ pins lstart to UTC so parsing it never depends on the factory's time zone.
    env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // `ps -p` exits 1 when none of the pids exist; that is an empty answer, not a failure.
  if (ps.exitCode !== 0 && !(pids && ps.stdout.length === 0)) {
    throw new Error(`ps exited ${ps.exitCode}: ${ps.stderr.toString().trim().slice(0, 200)}`);
  }
  const snap: Snapshot = new Map();
  for (const line of ps.stdout.toString().split("\n")) {
    const m = ROW.exec(line);
    if (!m) continue;
    const [, pid, ppid, pgid, stat, start] = m;
    snap.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), zombie: stat!.startsWith("Z"), start: start! });
  }
  return snap;
}

export interface ExitStatus {
  code: number | null;
  signal: string | null;
  /** Set when the executable could not be started. */
  error: string | null;
}

export interface AgentProcess {
  pid: number;
  /** Null when `ps` could not record it at spawn. */
  identity: ProcIdentity | null;
  /** Resolves once; never rejects. */
  exited: Promise<ExitStatus>;
  /** Epoch ms when the exit was observed, or null while running. */
  exitedAt: () => number | null;
  /** Signals through the child handle; a no-op once it has exited, so it never hits a recycled pid. */
  kill: (sig: NodeJS.Signals) => void;
}

export interface SpawnInput {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdoutFd: number;
  stderrFd: number;
  psPath: string;
}

/** Spawns the CLI as a new session and process-group leader, stdin from /dev/null. */
export function spawnAgentProcess(input: SpawnInput): AgentProcess {
  const child = spawn(input.executable, input.args, {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: ["ignore", input.stdoutFd, input.stderrFd],
  });
  let exitedAt: number | null = null;
  const exited = new Promise<ExitStatus>((resolve) => {
    child.once("exit", (code, signal) => {
      exitedAt = Date.now();
      resolve({ code, signal, error: null });
    });
    child.once("error", (err) => {
      exitedAt = Date.now();
      resolve({ code: null, signal: null, error: err.message });
    });
  });
  const pid = child.pid ?? -1;
  let identity: ProcIdentity | null = null;
  if (pid > 0) {
    try {
      const row = snapshot(input.psPath, [pid]).get(pid);
      if (row) identity = { pid, start: row.start };
    } catch {
      // Termination falls back to the handle and group, which stay safe while the child is unreaped.
    }
  }
  return {
    pid,
    identity,
    exited,
    exitedAt: () => exitedAt,
    kill: (sig) => {
      if (exitedAt === null && pid > 0) child.kill(sig);
    },
  };
}

/** The identities a termination owns: the root, its descendants, and members of the root's group. */
export class Tracker {
  readonly tracked = new Map<number, string>();

  constructor(readonly root: Pick<AgentProcess, "pid" | "identity" | "exitedAt">) {
    if (root.identity) this.tracked.set(root.pid, root.identity.start);
  }

  private matches(row: ProcRow | undefined): row is ProcRow {
    return row !== undefined && !row.zombie && this.tracked.get(row.pid) === row.start;
  }

  /**
   * A process group id is only recycled after the group empties and a new leader reuses the pid,
   * so a member that started before the root exited belongs to the root's group.
   */
  private inRootGroup(row: ProcRow): boolean {
    if (row.pgid !== this.root.pid) return false;
    const exitedAt = this.root.exitedAt();
    if (exitedAt === null) return true;
    const started = Date.parse(`${row.start} UTC`);
    return Number.isFinite(started) && started <= exitedAt;
  }

  /** Adopts newly visible descendants and group members; returns how many were added. */
  expand(snap: Snapshot): number {
    if (!this.root.identity && this.root.exitedAt() === null) {
      const row = snap.get(this.root.pid);
      if (row) this.tracked.set(row.pid, row.start); // an unreaped child's pid cannot be recycled
    }
    let added = 0;
    for (let grew = true; grew; ) {
      grew = false;
      for (const row of snap.values()) {
        if (row.zombie || this.tracked.has(row.pid)) continue;
        if (this.matches(snap.get(row.ppid)) || this.inRootGroup(row)) {
          this.tracked.set(row.pid, row.start);
          added++;
          grew = true;
        }
      }
    }
    return added;
  }

  /** Tracked processes other than the root whose identity still matches `snap`. */
  verified(snap: Snapshot): ProcIdentity[] {
    const out: ProcIdentity[] = [];
    for (const [pid, start] of this.tracked) {
      if (pid !== this.root.pid && this.matches(snap.get(pid))) out.push({ pid, start });
    }
    return out;
  }

  /** Whether the root's group still holds a process we own, so signalling the group cannot hit a stranger. */
  groupIsOurs(snap: Snapshot): boolean {
    if (this.root.exitedAt() === null) return true;
    for (const row of snap.values()) if (row.pgid === this.root.pid && this.matches(row)) return true;
    return false;
  }
}

export interface TerminationReport {
  /** Owned processes still alive when termination gave up. */
  survivors: ProcIdentity[];
  errors: string[];
}

export interface TerminateOptions {
  psPath: string;
  /** Time the tree gets to exit after SIGTERM. */
  graceMs?: number;
  /** Bound on every wait after SIGKILL. */
  killWaitMs?: number;
}

const FREEZE_ROUNDS = 5;

/**
 * Freeze, SIGTERM, wait, SIGKILL, verify.
 * Never throws: enumeration and signalling failures land in the report, and the handle is always signalled.
 */
export async function terminateTree(root: AgentProcess, opts: TerminateOptions): Promise<TerminationReport> {
  const { psPath, graceMs = 5_000, killWaitMs = 2_000 } = opts;
  const errors: string[] = [];
  const tracker = new Tracker(root);

  const discover = (): { snap: Snapshot; added: number } | null => {
    try {
      const snap = snapshot(psPath);
      return { snap, added: tracker.expand(snap) };
    } catch (err) {
      errors.push(`process snapshot failed: ${(err as Error).message}`);
      return null;
    }
  };
  const send = (sig: NodeJS.Signals, snap: Snapshot | undefined) => {
    root.kill(sig);
    if (!snap) return;
    for (const { pid } of tracker.verified(snap)) signalPid(pid, sig, errors);
    if (tracker.groupIsOurs(snap)) signalGroup(root.pid, sig, errors);
  };

  // 1. Stop the root through its handle first, so it can neither exit and orphan its children nor fork more,
  //    then stop what it already forked, until a snapshot finds nothing new.
  root.kill("SIGSTOP");
  for (let round = 0; round < FREEZE_ROUNDS; round++) {
    const d = discover();
    if (!d) break;
    send("SIGSTOP", d.snap);
    if (round > 0 && d.added === 0) break;
  }

  // 2. Ask everything to stop, then let it run its handlers.
  let d = discover();
  send("SIGTERM", d?.snap);
  send("SIGCONT", d?.snap);
  await Promise.race([root.exited, Bun.sleep(graceMs)]);

  // 3. Kill whatever is still ours, including children forked by TERM handlers and reparented group members.
  d = discover();
  send("SIGKILL", d?.snap);
  await Promise.race([root.exited, Bun.sleep(killWaitMs)]);
  if (root.exitedAt() === null) errors.push(`root pid ${root.pid} did not exit within ${killWaitMs}ms of SIGKILL`);

  // 4. Report survivors, giving killed processes a moment to disappear.
  let survivors: ProcIdentity[] = [];
  for (const deadline = Date.now() + killWaitMs; ; ) {
    d = discover();
    if (!d) break;
    survivors = tracker.verified(d.snap);
    if (survivors.length === 0 || Date.now() > deadline) break;
    send("SIGKILL", d.snap);
    await Bun.sleep(50);
  }
  return { survivors, errors };
}

/**
 * Darwin's killpg can fail with EPERM while the group holds a zombie.
 * Every member is also signalled one by one, where a real EPERM is reported, so EPERM here is not an error.
 */
function signalGroup(pgid: number, sig: NodeJS.Signals, errors: string[]): void {
  try {
    process.kill(-pgid, sig);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") errors.push(`killpg(${pgid}, ${sig}): ${(err as Error).message}`);
  }
}

function signalPid(pid: number, sig: NodeJS.Signals, errors: string[]): void {
  try {
    process.kill(pid, sig);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") errors.push(`kill(${pid}, ${sig}): ${(err as Error).message}`);
  }
}
