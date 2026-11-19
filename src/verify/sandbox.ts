/**
 * The sandbox for project commands (setup, preview, and later test, lint, and typecheck): a Seatbelt profile the factory
 * writes itself and applies with `/usr/bin/sandbox-exec`, chosen over `codex sandbox` and Claude's sandbox runtime in
 * spike 02 because it is the only one that lets a preview bind its own port while making no outbound connection at all.
 *
 * Closed by default. Reads are open except the dispatch deny-list; writes only in the given roots, never in the git
 * dirs; no mach services except user lookup, so the keychain daemon (securityd) is unreachable; no unix sockets except
 * DNS; and the network is one of: none, outbound IP except loopback (dependency install), or bind and accept on one
 * loopback port (preview).
 * Paths travel as `-D` parameters, never spliced into the profile text, so no path needs escaping.
 */
import { overlaps } from "../dispatch/policy";

export type NetworkMode = { kind: "none" } | { kind: "outbound" } | { kind: "serve"; port: number };

export interface ProjectSandbox {
  /** Absolute paths no project command may read (the dispatch deny-list, already expanded with realpaths). */
  denyRead: readonly string[];
  /** Absolute paths that stay read-only even under a writable root: the worktree's git dirs. */
  denyWrite: readonly string[];
  /** Canonical roots the command may write: the worktree and the preview's private home. */
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

/** The profile text and its `-D` parameters. Refuses a policy whose writable roots would reopen a denied path. */
export function sandboxProfile(s: ProjectSandbox): { profile: string; params: string[] } {
  assertAbsolute("deny-read", s.denyRead);
  assertAbsolute("deny-write", s.denyWrite);
  assertAbsolute("writable", s.writable);
  if (s.writable.length === 0) throw new Error("a project command needs at least one writable root");
  for (const w of s.writable) {
    for (const d of s.denyRead) if (overlaps(w, d)) throw new Error(`writable root ${w} overlaps denied ${d}`);
    for (const d of s.denyWrite) if (w === d || w.startsWith(`${d}/`)) throw new Error(`write-deny ${d} would cover writable root ${w}`);
  }
  const params: string[] = [];
  const param = (prefix: string, values: readonly string[]) =>
    values.map((v, i) => {
      params.push("-D", `${prefix}${i}=${v}`);
      return `(subpath (param "${prefix}${i}"))`;
    });
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow ipc-posix-sem)",
    `(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))`,
    "(allow file-read* file-test-existence)",
    ...(s.denyRead.length > 0 ? [`(deny file-read* ${param("DENY_READ_", s.denyRead).join(" ")})`] : []),
    `(allow file-write* ${param("WRITABLE_", s.writable).join(" ")})`,
    `(allow file-read* file-write* file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))`,
    `(allow file-read* file-write* (subpath "/dev/fd"))`,
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
