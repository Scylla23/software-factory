/**
 * Preview lifecycle: materialize an exact commit, run the project's setup commands sandboxed with egress only through
 * the factory's proxy, start its preview command sandboxed with only its own loopback port, wait until it answers, check that the listener
 * is ours, and tear everything down with the same supervision and worktree sweep as an agent run.
 */
import { closeSync, constants, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { assertPrivateDir, assertSafeDir, assertTrustedExecutable, type DispatchConfig, isUnder, tempRoots, trustedAgentPath } from "../dispatch/config";
import { gitWriteProtectedPaths } from "../dispatch/git";
import { effectiveDenyRead } from "../dispatch/policy";
import { type AgentProcess, assessCleanup, type ProcIdentity, snapshot, spawnAgentProcess, type Supervised, superviseRun, type SweepResult, sweepWorktree, type TerminationReport, Tracker } from "../dispatch/process";
import { type Materialized, materializeCommit, removeMaterialized } from "./materialize";
import { type PortRange, taskPort, tcpListeners } from "./port";
import { assertEgressHosts, type EgressProxy, startEgressProxy } from "./proxy";
import { canonicalRoots, carveOut, type NetworkMode, type ProjectSandbox, projectEnv, sandboxArgv, SYSTEM_READ } from "./sandbox";

/** What verification trusts, resolved once from factory-controlled sources like DispatchConfig. */
export interface VerifyConfig {
  executables: { git: string; ps: string; lsof: string; orca: string; sandboxExec: string };
  accountHome: string;
  stateRoot: string;
  harnessHomes: readonly string[];
  /** The whole PATH of a project command: verified tool dirs (such as Bun's), then the system dirs. */
  toolPath: string;
  /** Canonical toolchain dirs project commands may read (such as Bun's install dir); every tool dir is inside one. */
  toolRoots: readonly string[];
  /** Roots agents can write; a project checkout under any of them is refused. */
  untrustedRoots: readonly string[];
}

export function loadVerifyConfig(dispatch: DispatchConfig, opts: { toolDirs: readonly string[]; toolRoots: readonly string[]; agentWriteRoots: readonly string[] }): VerifyConfig {
  const untrustedRoots = [...tempRoots(), ...opts.agentWriteRoots.map((r) => realpathSync(r))];
  const toolRoots = toolchainRoots(opts.toolDirs, opts.toolRoots, untrustedRoots);
  return {
    executables: {
      git: dispatch.executables.git,
      ps: dispatch.executables.ps,
      lsof: dispatch.executables.lsof,
      orca: dispatch.executables.orca,
      sandboxExec: assertTrustedExecutable("/usr/bin/sandbox-exec", untrustedRoots),
    },
    accountHome: dispatch.accountHome,
    stateRoot: dispatch.stateRoot,
    harnessHomes: Object.values(dispatch.harnessHomes),
    toolPath: trustedAgentPath(opts.toolDirs, untrustedRoots),
    toolRoots,
    untrustedRoots,
  };
}

/**
 * The canonical toolchain roots project commands may read. Each must exist and sit outside agent-writable roots, and
 * every tool dir on the PATH must be inside one of them or a system dir: one the sandbox cannot read would fail every
 * command with a bare "Operation not permitted".
 */
export function toolchainRoots(toolDirs: readonly string[], roots: readonly string[], untrustedRoots: readonly string[]): string[] {
  const toolRoots = canonicalRoots("toolchain", roots);
  for (const r of toolRoots) for (const u of untrustedRoots) if (isUnder(r, u)) throw new Error(`toolchain root ${r} is under agent-writable ${u}`);
  const readable = [...toolRoots, ...canonicalRoots("system", SYSTEM_READ)];
  for (const d of canonicalRoots("tool", toolDirs)) if (!readable.some((r) => isUnder(d, r))) throw new Error(`tool dir ${d} is outside every toolchain root and system dir, so sandboxed commands could not read it`);
  return toolRoots;
}

/** A project's declared commands; each is an argv run under the sandbox with the tool PATH, never through a shell. */
export interface ProjectCommands {
  /** Run in order before the preview starts (dependency install), with egress only through the factory's proxy. */
  setup: readonly (readonly string[])[];
  /** Hosts setup may reach through the proxy, on 443 only, such as REGISTRY_HOSTS.npm. */
  egress: readonly string[];
  /** Serves the app on `$PORT` at 127.0.0.1, and may connect to that port only. */
  preview: readonly string[];
  /** Answers 200 once the preview is ready, such as `/health`. */
  readyPath: string;
  portRange: PortRange;
  /** Plain, non-secret variables the commands need. */
  env?: Readonly<Record<string, string>>;
}

export interface PreviewSpec {
  /** Attempt id, a lowercase UUID: names the attempt's directory under `<state root>/previews`, and its logs. */
  id: string;
  /** Picks the task's port within the range. */
  taskKey: string;
  repo: string;
  sha: string;
  /** Under the state root; receives `<id>.setup-<n>.log`, `<id>.preview.log`, and `<id>.<name>.log` per `run`. */
  logDir: string;
  project: ProjectCommands;
  setupTimeoutMs: number;
  readyTimeoutMs: number;
  /** The preview is torn down when it outlives this, even if nobody stops it. */
  maxLifetimeMs: number;
}

export interface TeardownReport {
  /** Termination of the preview process tree; null when it had already exited. */
  cleanup: TerminationReport | null;
  noKnownSurvivors: boolean;
  quarantineReasons: string[];
  /** Whether the worktree and home were removed; they are kept when anything may still run in them. */
  removed: boolean;
}

export interface Preview {
  id: string;
  sha: string;
  port: number;
  /** `http://127.0.0.1:<port>` */
  origin: string;
  worktree: string;
  home: string;
  logs: string[];
  /** ms from spawn until the ready path answered 200. */
  readyMs: number;
  /**
   * Runs one more command in the preview's worktree under the same sandbox, such as a probe or, later, a project check:
   * with no network, or with the preview's own profile (`serve`: its loopback port only). Never with egress.
   */
  run(argv: readonly string[], opts: { network: CheckNetwork; name: string; timeoutMs: number }): Promise<CommandResult>;
  /** Idempotent: the first call tears down, later calls return the same report. */
  stop(): Promise<TeardownReport>;
}

/** The networks a command beside the live preview may have; egress exists only in the setup phase. */
export type CheckNetwork = "none" | "serve";

export interface CommandResult {
  /** Null when it was stopped or killed by a signal. */
  exitCode: number | null;
  stopped: "cancelled" | "timed_out" | null;
  /** Anything it left running, or anything that could not be verified gone; empty when clean. */
  quarantineReasons: string[];
  logPath: string;
}

export class PreviewError extends Error {
  constructor(message: string, readonly teardown: TeardownReport | null, readonly logTail: string) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const READY_PROBE_TIMEOUT_MS = 2_000;
const READY_INTERVAL_MS = 200;

/** Opens a new private log under the state root (never through a symlink, never reusing a name). */
function openLog(config: VerifyConfig, logDir: string, name: string): { path: string; fd: number } {
  const dir = realpathSync(logDir);
  if (!isUnder(dir, config.stateRoot)) throw new Error(`log dir ${dir} is not under the state root ${config.stateRoot}`);
  assertSafeDir(dir, config.accountHome);
  for (const r of config.untrustedRoots) if (isUnder(dir, r)) throw new Error(`log dir ${dir} is under agent-writable ${r}`);
  const path = join(dir, name);
  return { path, fd: openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) };
}

function tail(path: string, bytes = 2_000): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.slice(-bytes);
  } catch {
    return "";
  }
}

interface SandboxedRun {
  proc: AgentProcess;
  supervised: Promise<Supervised>;
  abort: AbortController;
}

/** Spawns one project command under the sandbox as its own process group, supervised with a bound. */
function spawnSandboxed(config: VerifyConfig, sandbox: ProjectSandbox, argv: readonly string[], cwd: string, env: Record<string, string>, logFd: number, timeoutMs: number): SandboxedRun {
  const [exe, ...args] = sandboxArgv(config.executables.sandboxExec, sandbox, argv);
  const proc = spawnAgentProcess({ executable: exe!, args, cwd, env, stdoutFd: logFd, stderrFd: logFd, psPath: config.executables.ps });
  const abort = new AbortController();
  return { proc, abort, supervised: superviseRun(proc, { timeoutMs, signal: abort.signal, psPath: config.executables.ps }) };
}

/**
 * Sweeps the worktree and the home for leftovers and folds both sweeps with supervision's verdict. `spare` is the
 * running preview while it is still wanted: its server sits in the worktree too.
 */
async function settle(config: VerifyConfig, unverified: readonly string[], roots: readonly string[], spare: readonly ProcIdentity[] = []) {
  const merged: SweepResult = { found: [], cleanup: null, scanError: null };
  for (const root of roots) {
    const sweep = await sweepWorktree(root, { psPath: config.executables.ps, lsofPath: config.executables.lsof, spare });
    merged.found.push(...sweep.found);
    if (sweep.scanError) merged.scanError = [merged.scanError, `${root}: ${sweep.scanError}`].filter(Boolean).join("; ");
    if (sweep.cleanup) {
      merged.cleanup ??= { survivors: [], errors: [] };
      merged.cleanup.survivors.push(...sweep.cleanup.survivors);
      merged.cleanup.errors.push(...sweep.cleanup.errors);
    }
  }
  return assessCleanup(unverified, merged);
}

/**
 * Creates this attempt's own directory, `<state root>/previews/<id>`, with an exclusive mkdir, so nothing in it predates
 * the attempt and cleanup can never remove another attempt's files. The previews root must be private and outside
 * every agent-writable root: an agent that could write there could change the served files after HEAD was checked.
 */
export function reserveAttempt(config: Pick<VerifyConfig, "stateRoot" | "untrustedRoots">, id: string): string {
  if (!UUID.test(id)) throw new Error(`attempt id must be a lowercase UUID: ${id}`);
  const root = join(config.stateRoot, "previews");
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const real = assertPrivateDir(root, config.stateRoot);
  for (const r of config.untrustedRoots) if (isUnder(real, r) || isUnder(r, real)) throw new Error(`previews root ${real} overlaps agent-writable ${r}`);
  const dir = join(real, id);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`attempt ${id} already has a directory at ${dir}; it is left untouched`);
    throw err;
  }
  return dir;
}

/**
 * Materializes `spec.sha`, runs setup, starts the preview, and returns once it answers 200 on the ready path from a
 * listener inside the preview's own process tree. On any failure everything started is torn down before it throws.
 */
export async function startPreview(spec: PreviewSpec, config: VerifyConfig): Promise<Preview> {
  if (!UUID.test(spec.id)) throw new Error(`preview id must be a lowercase UUID: ${spec.id}`);
  if (!/^\/[A-Za-z0-9._~\/-]*$/.test(spec.project.readyPath)) throw new Error(`ready path must be a plain absolute path: ${spec.project.readyPath}`);
  if (spec.project.preview.length === 0) throw new Error("project has no preview command");
  assertEgressHosts(spec.project.egress);
  const attempt = reserveAttempt(config, spec.id);
  const home = join(attempt, "home");
  // Only what this attempt created is ever removed.
  let wt: Materialized | null = null;
  let homeMade = false;
  const logs: string[] = [];
  let preview: SandboxedRun | null = null;
  let report: Promise<TeardownReport> | null = null;

  const teardown = (): Promise<TeardownReport> => {
    report ??= (async () => {
      let cleanup: TerminationReport | null = null;
      let unverified: string[] = [];
      if (preview) {
        preview.abort.abort();
        const s = await preview.supervised;
        cleanup = s.cleanup;
        unverified = s.unverified;
      }
      const roots = [...(wt ? [wt.path] : []), ...(homeMade ? [home] : [])];
      const { noKnownSurvivors, quarantineReasons } = await settle(config, unverified, roots);
      const removed = quarantineReasons.length === 0;
      if (removed) {
        if (wt) removeMaterialized(config.executables.git, wt);
        if (homeMade) rmSync(home, { recursive: true, force: true });
        rmdirSync(attempt);
      }
      return { cleanup, noKnownSurvivors, quarantineReasons, removed };
    })();
    return report;
  };

  const fail = async (message: string, logPath: string | null): Promise<never> => {
    const t = await teardown();
    throw new PreviewError(message, t, logPath ? tail(logPath) : "");
  };

  try {
    wt = materializeCommit(config.executables.git, { repo: spec.repo, sha: spec.sha, root: attempt, name: "worktree", untrustedRoots: config.untrustedRoots });
    const worktree = wt.path;
    mkdirSync(home, { mode: 0o700 });
    homeMade = true;
    mkdirSync(join(home, "tmp"), { mode: 0o700 });
    const gitDirs = gitWriteProtectedPaths(config.executables.git, worktree);
    if (gitDirs.length === 0) throw new Error(`${worktree} has no git dirs`);
    const base = {
      // The project's own git dirs (read-only) and the toolchain; everything else outside the worktree and home is closed.
      readable: [gitDirs[0]!, ...config.toolRoots],
      // The attempt's own directory sits in the state root, so the state root's entry gives way to everything in it
      // but this attempt: its other files, the harness homes, and the other attempts stay on the deny-list.
      denyRead: carveOut(effectiveDenyRead({ accountHome: config.accountHome, stateRoot: config.stateRoot, harnessHomes: config.harnessHomes }), attempt),
      denyWrite: gitDirs,
      writable: [worktree, realpathSync(home)],
    };
    const sandbox = (network: NetworkMode): ProjectSandbox => ({ ...base, network });
    const user = userInfo().username;
    let port: number | null = null;
    const env = (extra: { port?: number; proxy?: string }) => projectEnv({ home: base.writable[1]!, path: config.toolPath, user, declared: spec.project.env, ...extra });

    const runCommand = async (argv: readonly string[], opts: { network: NetworkMode; name: string; timeoutMs: number; proxy?: string }): Promise<CommandResult> => {
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(opts.name)) throw new Error(`command name must be [a-z0-9-]: ${opts.name}`);
      if (report) throw new Error("preview was stopped");
      // The sweep after the command spares the live preview by identity; without one it could not tell them apart.
      if (preview && preview.proc.exitedAt() === null && !preview.proc.identity) throw new Error("the running preview has no recorded identity, so a command beside it cannot be swept safely");
      const log = openLog(config, spec.logDir, `${spec.id}.${opts.name}.log`);
      logs.push(log.path);
      let r: SandboxedRun;
      try {
        const e = env({ ...(opts.network.kind === "serve" ? { port: opts.network.port } : {}), ...(opts.proxy ? { proxy: opts.proxy } : {}) });
        r = spawnSandboxed(config, sandbox(opts.network), argv, worktree, e, log.fd, opts.timeoutMs);
      } finally {
        closeSync(log.fd);
      }
      const s = await r.supervised;
      const live = preview && preview.proc.exitedAt() === null && preview.proc.identity ? [preview.proc.identity] : [];
      const settled = await settle(config, s.unverified, [worktree, home], live);
      const reasons = [...settled.quarantineReasons, ...(s.status?.error ? [`spawn failed: ${s.status.error}`] : [])];
      return { exitCode: s.status?.code ?? null, stopped: s.stopped, quarantineReasons: reasons, logPath: log.path };
    };

    const run = (argv: readonly string[], opts: { network: CheckNetwork; name: string; timeoutMs: number }): Promise<CommandResult> => {
      // Checked at run time too: a caller outside the type system must not get the setup phase's egress back.
      if (opts.network !== "none" && opts.network !== "serve") return Promise.reject(new Error(`a command beside the preview may not have network ${JSON.stringify(opts.network)}`));
      if (opts.network === "serve" && port === null) return Promise.reject(new Error("no preview port yet"));
      return runCommand(argv, { name: opts.name, timeoutMs: opts.timeoutMs, network: opts.network === "serve" ? { kind: "serve", port: port! } : { kind: "none" } });
    };

    // The setup phase: egress only through a proxy that lives exactly as long as the phase. Stopping it revokes the
    // network of every process the phase started, including any the sweeps did not find.
    if (spec.project.setup.length > 0) {
      const egressLog = openLog(config, spec.logDir, `${spec.id}.egress.log`);
      logs.push(egressLog.path);
      let proxy: EgressProxy | null = null;
      try {
        proxy = startEgressProxy({ allow: spec.project.egress, logFd: egressLog.fd });
        for (const [i, argv] of spec.project.setup.entries()) {
          const r = await runCommand(argv, { network: { kind: "proxy", port: proxy.port }, proxy: proxy.url, name: `setup-${i}`, timeoutMs: spec.setupTimeoutMs });
          if (r.stopped || r.exitCode !== 0 || r.quarantineReasons.length > 0) {
            const why = r.stopped ?? `exit ${r.exitCode ?? "by signal"}`;
            return await fail(`setup command ${i} (${argv[0]}) did not succeed: ${why}${r.quarantineReasons.length ? `; ${r.quarantineReasons.join("; ")}` : ""}`, r.logPath);
          }
        }
      } finally {
        proxy?.stop();
        closeSync(egressLog.fd);
      }
    }

    port = await taskPort(spec.project.portRange, spec.taskKey);
    const origin = `http://127.0.0.1:${port}`;
    const log = openLog(config, spec.logDir, `${spec.id}.preview.log`);
    logs.push(log.path);
    try {
      preview = spawnSandboxed(config, sandbox({ kind: "serve", port }), spec.project.preview, worktree, env({ port }), log.fd, spec.maxLifetimeMs);
    } finally {
      closeSync(log.fd);
    }
    const started = Date.now();
    const ready = await waitReady(`${origin}${spec.project.readyPath}`, spec.readyTimeoutMs, preview.proc.exited);
    if (!ready.ok) return await fail(`preview not ready: ${ready.reason}`, log.path);
    const owned = listenerOwnership(config, port, preview.proc);
    if (!owned.ok) return await fail(`port ${port} is not served by the preview: ${owned.reason}`, log.path);
    return { id: spec.id, sha: spec.sha, port, origin, worktree, home: base.writable[1]!, logs, readyMs: Date.now() - started, run, stop: teardown };
  } catch (err) {
    if (err instanceof PreviewError) throw err;
    const t = await teardown();
    throw new PreviewError(`preview failed: ${(err as Error).message}`, t, "");
  }
}

export type Readiness = { ok: true } | { ok: false; reason: string };

/**
 * Polls `url` until it answers 200, the process exits, or `timeoutMs` passes. Redirects are not followed: a ready path
 * that redirects is a misdeclared ready path.
 */
export async function waitReady(url: string, timeoutMs: number, exited: Promise<unknown>, fetchImpl: typeof fetch = fetch): Promise<Readiness> {
  let gone = false;
  void exited.then(() => (gone = true));
  const deadline = Date.now() + timeoutMs;
  let last = "no answer";
  while (Date.now() < deadline) {
    if (gone) return { ok: false, reason: `the preview process exited (last probe: ${last})` };
    try {
      const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(READY_PROBE_TIMEOUT_MS) });
      await res.arrayBuffer();
      if (res.status === 200) return { ok: true };
      last = `status ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await Bun.sleep(READY_INTERVAL_MS);
  }
  return { ok: false, reason: `no 200 from ${url} within ${timeoutMs}ms (last probe: ${last})` };
}

/** Every listener on the port must be the preview's root or one of its descendants, and there must be one. */
export function listenerOwnership(config: Pick<VerifyConfig, "executables">, port: number, root: Pick<AgentProcess, "pid" | "identity" | "exitedAt">): Readiness & { pids?: number[] } {
  let pids: number[];
  let snap;
  try {
    pids = tcpListeners(config.executables.lsof, port);
    snap = snapshot(config.executables.ps);
  } catch (err) {
    return { ok: false, reason: `cannot list listeners: ${(err as Error).message}` };
  }
  if (pids.length === 0) return { ok: false, reason: "nothing of this user listens on it" };
  const tracker = new Tracker(root);
  tracker.expand(snap);
  const strangers = pids.filter((p) => !tracker.tracked.has(p));
  if (strangers.length > 0) return { ok: false, reason: `listener pids ${strangers.join(", ")} are outside the preview's process tree` };
  return { ok: true, pids };
}
