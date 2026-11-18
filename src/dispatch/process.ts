/**
 * Both CLIs run tool commands in their own process groups.
 * On SIGTERM Claude reaps them but Codex leaves them orphaned, and on SIGKILL both do,
 * so cancellation signals the whole tree as snapshotted from the root pid.
 */

const KILL_GRACE_MS = 5_000;

export function descendants(root: number): number[] {
  const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
  if (ps.exitCode !== 0) throw new Error("ps failed while collecting the process tree");
  const children = new Map<number, number[]>();
  for (const line of ps.stdout.toString().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined || Number.isNaN(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM the tree, wait for the root, then SIGKILL anything still alive. */
export async function terminateTree(proc: Bun.Subprocess, graceMs = KILL_GRACE_MS): Promise<void> {
  const tree = new Set(descendants(proc.pid));
  signal(proc.pid, "SIGTERM");
  for (const pid of tree) signal(pid, "SIGTERM");
  await Promise.race([proc.exited, Bun.sleep(graceMs)]);
  // Children spawned after the first snapshot are still parented to a survivor.
  for (const pid of [...tree]) if (alive(pid)) for (const d of descendants(pid)) tree.add(d);
  for (const pid of tree) if (alive(pid)) signal(pid, "SIGKILL");
  if (proc.exitCode === null && proc.signalCode === null) signal(proc.pid, "SIGKILL");
  await proc.exited;
}
