/**
 * The sandbox for project commands (setup, preview, and later test, lint, and typecheck): a Seatbelt profile the factory
 * writes itself and applies with `/usr/bin/sandbox-exec`, chosen over `codex sandbox` and Claude's sandbox runtime in
 * spike 02 because it is the only one that lets a preview bind its own port while connecting nowhere but to itself.
 *
 * Closed by default. Reads only in the readable roots (the project, its private home, its git dirs, the toolchain) and
 * the system list below, with the dispatch deny-list applied again on top; writes only in the writable roots, never in
 * the git dirs; no mach services except user lookup, so the keychain daemon (securityd) is unreachable; no unix sockets;
 * and the network is one of: none, the factory's egress proxy only (setup), or the preview's own loopback port only.
 * Paths travel as `-D` parameters, never spliced into the profile text, so no path needs escaping.
 */
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
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

/**
 * none: no network. proxy: outbound only to the factory's egress proxy on that loopback port (setup). serve: bind and
 * accept on the preview's port, and connect only to that same port, so an app can call itself (preview).
 *
 * Every rule is IPv4 only: Seatbelt's `localhost` also matches `::1` and `[::]`, where any process could listen on
 * the same port number. No mode may listen except serve on its own port, so no sandboxed process can run a relay.
 * Seatbelt cannot tell 127.0.0.1 from other local addresses (its hosts are only `*` and `localhost`), so serve could
 * still bind its port on 0.0.0.0 or a LAN address; the factory refuses such a preview from its listener check.
 */
export type NetworkMode = { kind: "none" } | { kind: "proxy"; port: number } | { kind: "serve"; port: number };

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

/**
 * The deny-list with room for `keep`: each denied path that contains `keep` is replaced by its entries, level by level,
 * except the ones leading to `keep`, so everything beside `keep` stays denied. Entries created later are not on the
 * list, but reads outside the readable roots are closed anyway; this list is the second layer.
 */
export function carveOut(deny: readonly string[], keep: string): string[] {
  const out: string[] = [];
  for (const d of deny) {
    if (keep === d) throw new Error(`${keep} is itself denied`);
    if (!keep.startsWith(`${d}/`)) {
      out.push(d);
      continue;
    }
    for (let cur = d; cur !== keep; ) {
      const slash = keep.indexOf("/", cur.length + 1);
      const next = slash < 0 ? keep : keep.slice(0, slash);
      for (const name of readdirSync(cur)) if (join(cur, name) !== next) out.push(join(cur, name));
      cur = next;
    }
  }
  return [...new Set(out)];
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
    case "proxy":
      assertPort(n.port);
      // No DNS, no unix sockets, no other port, no listening: the proxy resolves names and decides which hosts are
      // reachable. The deny repeats the default so that no later allow can give setup a listener.
      return ["(allow system-socket)", `(allow network-outbound (remote tcp4 "localhost:${n.port}"))`, "(deny network-bind network-inbound)"];
    case "serve":
      assertPort(n.port);
      return [
        "(allow system-socket)",
        `(allow network-bind network-inbound (local tcp4 "localhost:${n.port}"))`,
        `(allow network-outbound (remote tcp4 "localhost:${n.port}"))`,
      ];
  }
}

/** argv for running `command` under the profile with `/usr/bin/sandbox-exec` (or the trusted path given). */
export function sandboxArgv(sandboxExec: string, s: ProjectSandbox, command: readonly string[]): string[] {
  if (command.length === 0 || command[0] === "") throw new Error("empty project command");
  const { profile, params } = sandboxProfile(s);
  return [sandboxExec, "-p", profile, ...params, "--", ...command];
}

/** Names a project may not set in its declared env; the factory's own variables can never be overridden. */
const RESERVED_ENV = new Set(["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG", "PORT", "SHELL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);

export interface ProjectEnvInput {
  /** The preview's private home; TMPDIR is `<home>/tmp`. */
  home: string;
  /** The verified tool PATH (see `trustedAgentPath`). */
  path: string;
  user: string;
  /** The project's declared variables: plain values, never secrets. */
  declared?: Readonly<Record<string, string>>;
  port?: number;
  /** The egress proxy URL of the setup phase, with its credential. */
  proxy?: string;
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
  if (input.proxy !== undefined) {
    if (!/^http:\/\/factory:[0-9a-f]+@127\.0\.0\.1:\d+$/.test(input.proxy)) throw new Error("proxy must be the factory egress proxy URL");
    // Both spellings: curl and pip read the lowercase names, Bun and npm the uppercase ones.
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) env[k] = input.proxy;
  }
  return env;
}
