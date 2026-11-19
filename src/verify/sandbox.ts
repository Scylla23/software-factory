/**
 * The sandbox for project commands (setup, preview, and later test, lint, and typecheck): a Seatbelt profile the factory
 * writes itself and applies with `/usr/bin/sandbox-exec`, chosen over `codex sandbox` and Claude's sandbox runtime in
 * spike 02 because it is the only one that lets a preview bind its own port while making no outbound connection at all.
 *
 * Closed by default. Reads only in the readable roots (the project, its private home, its git dirs, the toolchain) and
 * the system list below, with the dispatch deny-list applied again on top; writes only in the writable roots, never in
 * the git dirs; no mach services except user lookup, so the keychain daemon (securityd) is unreachable; no unix sockets;
 * and the network is one of: none, the factory's egress proxy only (setup), or the preview's own loopback port only.
 * Paths travel as `-D` parameters, never spliced into the profile text, so no path needs escaping.
 */
import { realpathSync } from "node:fs";
import { overlaps } from "../dispatch/policy";

/**
 * What every project command may read besides its readable roots: system binaries, libraries, frameworks, the dyld
 * cache, the Command Line Tools (git and python3 shims), the links that select them and /bin/sh, configuration under
 * /etc, and time zones. Nothing under /Users, /Volumes, /opt, /usr/local, or /private/var/folders.
 */
export const SYSTEM_READ = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/libexec",
  "/usr/share",
  "/System/Library",
  "/System/Cryptexes",
  "/System/Volumes/Preboot/Cryptexes",
  "/Library/Apple/usr/lib",
  "/Library/Developer/CommandLineTools",
  "/private/etc",
  "/private/var/db/timezone",
  "/private/var/select",
] as const;

/** Device files every command may read and write. */
const DEVICES = ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/dtracehelper"];

export type NetworkMode = { kind: "none" } | { kind: "outbound" } | { kind: "serve"; port: number };

export interface ProjectSandbox {
  /** Canonical roots the command may read besides the writable roots and SYSTEM_READ: git dirs and the toolchain. */
  readable: readonly string[];
  /** Absolute paths no project command may read, even inside a readable root (the dispatch deny-list, with realpaths). */
  denyRead: readonly string[];
  /** Absolute paths that stay read-only even under a writable root: the worktree's git dirs. */
  denyWrite: readonly string[];
  /** Canonical roots the command may read and write: the worktree and the preview's private home. */
  writable: readonly string[];
  network: NetworkMode;
}

function assertAbsolute(kind: string, paths: readonly string[]): void {
  for (const p of paths) {
    if (!p.startsWith("/") || p.includes("\0") || p.includes("*")) throw new Error(`${kind} path must be absolute, without globs: ${JSON.stringify(p)}`);
  }
}

export function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`port must be an integer in 1024-65535: ${port}`);
}

/**
 * The canonical form of each root, which must exist: Seatbelt matches resolved paths, so a root given through a
 * symlink would silently allow nothing, and a missing toolchain or system path is a setup error to fix, not to skip.
 */
export function canonicalRoots(kind: string, paths: readonly string[]): string[] {
  return paths.map((p) => {
    try {
      return realpathSync(p);
    } catch {
      throw new Error(`sandbox ${kind} path does not exist: ${p}`);
    }
  });
}

/** Every proper ancestor of `path`, from `/` down, so lookups can stat their way to a readable root. */
function ancestors(path: string): string[] {
  const out = ["/"];
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) out.push(`/${parts.slice(0, i).join("/")}`);
  return out;
}

/** The profile text and its `-D` parameters. Refuses a policy whose readable or writable roots would reopen a denied path. */
export function sandboxProfile(s: ProjectSandbox): { profile: string; params: string[] } {
  assertAbsolute("deny-read", s.denyRead);
  assertAbsolute("deny-write", s.denyWrite);
  assertAbsolute("writable", s.writable);
  assertAbsolute("readable", s.readable);
  if (s.writable.length === 0) throw new Error("a project command needs at least one writable root");
  for (const w of s.writable) {
    for (const d of s.denyRead) if (overlaps(w, d)) throw new Error(`writable root ${w} overlaps denied ${d}`);
    for (const d of s.denyWrite) if (w === d || w.startsWith(`${d}/`)) throw new Error(`write-deny ${d} would cover writable root ${w}`);
  }
  for (const r of s.readable) for (const d of s.denyRead) if (r === d || r.startsWith(`${d}/`)) throw new Error(`readable root ${r} is inside denied ${d}`);
  const system = canonicalRoots("system", SYSTEM_READ);
  const params: string[] = [];
  const param = (prefix: string, values: readonly string[], kind: "subpath" | "literal" = "subpath") =>
    values.map((v, i) => {
      params.push("-D", `${prefix}${i}=${v}`);
      return `(${kind} (param "${prefix}${i}"))`;
    });
  const roots = [...s.writable, ...s.readable, ...system];
  const insideRoot = (a: string) => roots.some((r) => a === r || a.startsWith(`${r}/`));
  // Bun's resolver lists every directory above its working directory and fails without them ("error loading current
  // directory", or an empty process.env), so the directories above a writable root may be listed; names only, since
  // the files in them stay closed. Above any other root, lookups may only stat.
  const listable = [...new Set(s.writable.flatMap(ancestors))].filter((a) => a !== "/" && !insideRoot(a));
  const lookups = [...new Set([...roots.flatMap(ancestors), "/etc", "/var", "/tmp"])].filter((a) => a !== "/" && !insideRoot(a) && !listable.includes(a));
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow ipc-posix-sem)",
    `(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))`,
    `(allow file-read-metadata ${param("LOOKUP_", lookups, "literal").join(" ")})`,
    ...(listable.length > 0 ? [`(allow file-read-metadata file-read-data ${param("LIST_", listable, "literal").join(" ")})`] : []),
    // dyld reads the root directory itself at every exec; its listing names only the top-level system folders.
    `(allow file-read* (literal "/"))`,
    `(allow file-read* ${param("SYSTEM_", system).join(" ")})`,
    // A rule with no filter would match everything, so an empty list emits no rule at all.
    ...(s.readable.length > 0 ? [`(allow file-read* ${param("READABLE_", s.readable).join(" ")})`] : []),
    `(allow file-read* file-write* ${param("WRITABLE_", s.writable).join(" ")})`,
    `(allow file-read* file-write* file-ioctl ${DEVICES.map((d) => `(literal "${d}")`).join(" ")})`,
    `(allow file-read* file-write* (subpath "/dev/fd"))`,
    // The dispatch deny-list again, so a readable root can never reopen a credential store or the state root.
    ...(s.denyRead.length > 0 ? [`(deny file-read* file-write* ${param("DENY_READ_", s.denyRead).join(" ")})`] : []),
    ...(s.denyWrite.length > 0 ? [`(deny file-write* ${param("DENY_WRITE_", s.denyWrite).join(" ")})`] : []),
    ...networkRules(s.network),
  ];
  return { profile: `${lines.join("\n")}\n`, params };
}

function networkRules(n: NetworkMode): string[] {
  switch (n.kind) {
    case "none":
      return [];
    case "outbound":
      // IP connections and the system DNS socket only: a bare `network-outbound` would also open every unix socket
      // (ssh-agent, Docker, the Orca runtime), which reaches outside the sandbox. Loopback is denied too, so an install
      // script cannot talk to the owner's local servers.
      return [
        "(allow system-socket)",
        `(allow network-outbound (remote ip) (literal "/private/var/run/mDNSResponder"))`,
        `(deny network-outbound (remote ip "localhost:*"))`,
      ];
    case "serve":
      assertPort(n.port);
      // Bind and accept on this loopback port only; no outbound connection, not even to another local port.
      return [
        "(allow system-socket)",
        `(allow network-bind network-inbound (local ip "localhost:${n.port}"))`,
      ];
  }
}

/** argv for running `command` under the profile with `/usr/bin/sandbox-exec` (or the trusted path given). */
export function sandboxArgv(sandboxExec: string, s: ProjectSandbox, command: readonly string[]): string[] {
  if (command.length === 0 || command[0] === "") throw new Error("empty project command");
  const { profile, params } = sandboxProfile(s);
  return [sandboxExec, "-p", profile, ...params, "--", ...command];
}

/** Names a project may set in its declared env; the factory's own variables can never be overridden. */
const RESERVED_ENV = new Set(["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG", "PORT", "SHELL"]);

export interface ProjectEnvInput {
  /** The preview's private home; TMPDIR is `<home>/tmp`. */
  home: string;
  /** The verified tool PATH (see `trustedAgentPath`). */
  path: string;
  user: string;
  /** The project's declared variables: plain values, never secrets. */
  declared?: Readonly<Record<string, string>>;
  port?: number;
}

/** The whole environment of a project command; nothing is inherited from the factory. */
export function projectEnv(input: ProjectEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.declared ?? {})) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k) || RESERVED_ENV.has(k)) throw new Error(`project env may not set ${JSON.stringify(k)}`);
    if (v.includes("\0")) throw new Error(`project env ${k} has a NUL byte`);
    env[k] = v;
  }
  Object.assign(env, {
    HOME: input.home,
    TMPDIR: `${input.home}/tmp`,
    PATH: input.path,
    USER: input.user,
    LOGNAME: input.user,
    LANG: "en_US.UTF-8",
  });
  if (input.port !== undefined) {
    assertPort(input.port);
    env.PORT = String(input.port);
  }
  return env;
}
