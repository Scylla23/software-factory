import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEgressProxy } from "../src/verify/proxy";
import { canonicalRoots, carveOut, type NetworkMode, projectEnv, type ProjectSandbox, sandboxArgv, sandboxProfile } from "../src/verify/sandbox";
import { BUN_DIR } from "./verify-helpers";

let dir: string;
let writable: string;
let secret: string;
let gitDir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "verify-sbx-")));
  writable = join(dir, "wt");
  mkdirSync(writable);
  gitDir = join(writable, ".gitdir");
  mkdirSync(gitDir);
  mkdirSync(join(dir, "secret"));
  secret = join(dir, "secret", "token.txt");
  writeFileSync(secret, "SECRET-VALUE\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const policy = (network: NetworkMode, extra: Partial<ProjectSandbox> = {}): ProjectSandbox => ({
  readable: [BUN_DIR],
  denyRead: [join(dir, "secret")],
  denyWrite: [gitDir],
  writable: [writable],
  network,
  ...extra,
});

/** Runs `script` with /bin/sh under the sandbox, in the writable root as a project command would, and returns stdout. */
function run(p: ProjectSandbox, script: string, env: Record<string, string> = { PATH: `${BUN_DIR}:/usr/bin:/bin` }, cwd?: string): string {
  const r = Bun.spawnSync(sandboxArgv("/usr/bin/sandbox-exec", p, ["/bin/sh", "-c", script]), { env, cwd: cwd ?? writable, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  return r.stdout.toString();
}

describe("sandboxProfile", () => {
  test("paths travel only as parameters, never in the profile text", () => {
    const odd = join(dir, `we"ird) (allow default`);
    mkdirSync(odd);
    const { profile, params } = sandboxProfile(policy({ kind: "none" }, { writable: [odd] }));
    expect(profile).not.toContain(odd);
    expect(profile).not.toContain("(allow default");
    expect(params).toContain(`WRITABLE_0=${odd}`);
    // And it still works: the oddly named root is writable.
    expect(run(policy({ kind: "none" }, { writable: [odd] }), `: > '${odd.replaceAll("'", "'\\''")}/f' && echo WROTE`)).toBe("WROTE\n");
  });

  test("refuses writable roots that would reopen a denied path or sit under a write-deny, and globs", () => {
    expect(() => sandboxProfile(policy({ kind: "none" }, { writable: [join(dir, "secret", "sub")] }))).toThrow("overlaps denied");
    expect(() => sandboxProfile(policy({ kind: "none" }, { writable: [dir] }))).toThrow("overlaps denied");
    expect(() => sandboxProfile(policy({ kind: "none" }, { denyWrite: [dir] }))).toThrow("would cover writable root");
    expect(() => sandboxProfile(policy({ kind: "none" }, { denyRead: ["~/.ssh"] }))).toThrow("absolute");
    expect(() => sandboxProfile(policy({ kind: "none" }, { denyRead: ["/a/*"] }))).toThrow("without globs");
    expect(() => sandboxProfile(policy({ kind: "serve", port: 80 }))).toThrow("1024-65535");
  });
});

describe("carveOut", () => {
  test("keeps everything beside the kept path denied, level by level", () => {
    for (const d of ["state/a", "state/previews/x/inner", "state/previews/y", "other"]) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, "state", "key.json"), "k");
    const keep = join(dir, "state", "previews", "x");
    expect(carveOut([join(dir, "state"), join(dir, "other")], keep).sort()).toEqual(
      [join(dir, "other"), join(dir, "state", "a"), join(dir, "state", "key.json"), join(dir, "state", "previews", "y")].sort(),
    );
    expect(() => carveOut([keep], keep)).toThrow("is itself denied");
  });
});

describe("files", () => {
  test("denied paths cannot be read, directly or by search, while other files can", () => {
    const out = run(policy({ kind: "none" }), `cat '${secret}' 2>&1; grep -r SECRET '${dir}/secret' 2>&1; ls '${dir}/secret' 2>&1; cat /etc/hosts >/dev/null && echo READ-OTHER-OK`);
    expect(out).not.toContain("SECRET-VALUE");
    expect(out).toContain("Operation not permitted");
    expect(out).toContain("READ-OTHER-OK");
  });

  test("reads are closed by default: an unrelated file outside every root is unreadable without being on any deny-list", () => {
    const sibling = join(dir, "sibling-project");
    mkdirSync(sibling);
    writeFileSync(join(sibling, ".env"), "SIBLING-CANARY\n");
    writeFileSync(join(writable, "own.txt"), "OWN-FILE\n");
    const out = run(policy({ kind: "none" }), `cat '${sibling}/.env' 2>&1; ls '${dir}' 2>&1; ls /Users 2>&1; cat own.txt; head -c 2 /etc/hosts >/dev/null && echo SYSTEM-OK; bun -e 'console.log("TOOL-OK")'`);
    expect(out).not.toContain("SIBLING-CANARY");
    // Residual: the directory above the worktree may be listed (Bun needs it), so the sibling's name shows, not its files.
    expect(out.split("\n")).toContain("sibling-project");
    expect(out.match(/Operation not permitted/g)?.length).toBe(2); // the sibling's .env and /Users
    expect(out).toContain("OWN-FILE");
    expect(out).toContain("SYSTEM-OK");
    expect(out).toContain("TOOL-OK");
  });

  test("a readable root is readable, not writable, and the deny-list still applies inside it", () => {
    const lib = join(dir, "lib");
    mkdirSync(join(lib, "private"), { recursive: true });
    writeFileSync(join(lib, "a.txt"), "LIB-FILE\n");
    writeFileSync(join(lib, "private", "k"), "LIB-SECRET\n");
    const out = run(policy({ kind: "none" }, { readable: [lib], denyRead: [join(lib, "private")] }), `cat '${lib}/a.txt'; : > '${lib}/w' 2>/dev/null || echo WRITE-DENIED; cat '${lib}/private/k' 2>&1`);
    expect(out).toContain("LIB-FILE");
    expect(out).toContain("WRITE-DENIED");
    expect(out).not.toContain("LIB-SECRET");
    expect(existsSync(join(lib, "w"))).toBe(false);
  });

  test("a readable root inside a denied path is refused, and a missing root fails loudly naming it", () => {
    expect(() => sandboxProfile(policy({ kind: "none" }, { readable: [join(dir, "secret", "x")] }))).toThrow("is inside denied");
    expect(() => canonicalRoots("toolchain", [join(dir, "no-such-tool")])).toThrow(`sandbox toolchain path does not exist: ${join(dir, "no-such-tool")}`);
  });

  test("writes land only in the writable roots, never in the git dir or elsewhere", () => {
    const outside = join(dir, "outside");
    const out = run(policy({ kind: "none" }), `: > '${writable}/ok' && echo WT-OK; : > '${gitDir}/marker' 2>/dev/null || echo GIT-DENIED; : > '${outside}' 2>/dev/null || echo OUTSIDE-DENIED; : > /tmp/verify-sbx-$$ 2>/dev/null || echo TMP-DENIED`);
    expect(out.split("\n")).toEqual(["WT-OK", "GIT-DENIED", "OUTSIDE-DENIED", "TMP-DENIED", ""]);
    expect(existsSync(join(gitDir, "marker"))).toBe(false);
    expect(existsSync(outside)).toBe(false);
  });

  test("the keychain daemon is unreachable: no mach service but user lookup", () => {
    // `security` needs com.apple.SecurityServer; denied, it cannot even open the default keychain list.
    const out = run(policy({ kind: "none" }), "/usr/bin/security list-keychains >/dev/null 2>&1; echo rc=$?; id -un >/dev/null && echo LOOKUP-OK");
    expect(out).toContain("LOOKUP-OK");
    expect(out).not.toContain("rc=0");
  });
});

/** A loopback server outside the sandbox, standing in for the owner's local services. */
const DNS_SOCKET = "/private/var/run/mDNSResponder";

function ownerService(): { port: number; stop: () => void } {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("owner-service") });
  return { port: s.port!, stop: () => s.stop(true) };
}

/** Like `run`, without blocking the event loop, for commands that talk to a server in this test process. */
async function runAsync(p: ProjectSandbox, script: string, env: Record<string, string> = { PATH: `${BUN_DIR}:/usr/bin:/bin` }): Promise<string> {
  const proc = Bun.spawn(sandboxArgv("/usr/bin/sandbox-exec", p, ["/bin/sh", "-c", script]), { env, cwd: writable, stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  return out;
}

describe("network", () => {
  const curl = (url: string, extra = "") => `/usr/bin/curl -sS -m 3 ${extra} -o /dev/null -w '%{http_code}' ${url} 2>/dev/null; echo`;
  const connect = (path: string) => `${process.execPath} -e 'try { await Bun.connect({unix:"${path}",socket:{data(){}}}); console.log("UNIX-OPEN") } catch { console.log("UNIX-DENIED") } process.exit(0)'`;

  test("serve: binds its own port and may call itself, but no other port, no other loopback service, and no outbound", async () => {
    const owner = ownerService();
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const app = `const tryFetch = (u) => fetch(u, { signal: AbortSignal.timeout(3000) }).then((r) => r.text(), () => "DENIED");
Bun.serve({ hostname: "127.0.0.1", port: ${port}, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/api") return new Response("api");
  if (path === "/self") return new Response("self:" + await tryFetch("http://127.0.0.1:${port}/api"));
  if (path === "/lateral") return new Response("lateral:" + await tryFetch("http://127.0.0.1:${owner.port}/"));
  if (path === "/out") return new Response("out:" + await tryFetch("http://1.1.1.1/"));
  return new Response("in-sandbox");
} });
setTimeout(() => process.exit(0), 15000);`;
    writeFileSync(join(writable, "app.js"), app);
    const p = policy({ kind: "serve", port });
    const proc = Bun.spawn(sandboxArgv("/usr/bin/sandbox-exec", p, [process.execPath, "app.js"]), { env: { PATH: "/usr/bin:/bin" }, cwd: writable, stdout: "ignore", stderr: "ignore" });
    try {
      const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) }).then((r) => r.text(), () => "");
      let body = "";
      for (let i = 0; i < 50 && body !== "in-sandbox"; i++) {
        await Bun.sleep(100);
        body = await get("/");
      }
      expect(body).toBe("in-sandbox");
      expect(await get("/self")).toBe("self:api");
      expect(await get("/lateral")).toBe("lateral:DENIED");
      expect(await get("/out")).toBe("out:DENIED");
      expect(run(p, curl(`http://127.0.0.1:${owner.port}/`))).toBe("000\n");
      expect(run(p, connect(DNS_SOCKET)).trim()).toBe("UNIX-DENIED");
      const other = run(p, `${process.execPath} -e 'try { Bun.serve({hostname:"127.0.0.1",port:${port + 1},fetch:()=>new Response("")}); console.log("BOUND") } catch (e) { console.log("BIND-DENIED") }; process.exit(0)'`);
      expect(other.trim()).toBe("BIND-DENIED");
    } finally {
      proc.kill("SIGKILL");
      owner.stop();
    }
  });

  test("none: cannot connect, not even to loopback", () => {
    const owner = ownerService();
    try {
      expect(run(policy({ kind: "none" }), curl(`http://127.0.0.1:${owner.port}/`))).toBe("000\n");
    } finally {
      owner.stop();
    }
  });

  test("proxy: reaches allowlisted hosts through the factory proxy only; no direct connection, DNS, or unix socket", async () => {
    const owner = ownerService();
    const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("registry") });
    const logFd = openSync(join(dir, "egress.log"), "wx", 0o600);
    const proxy = startEgressProxy({ allow: ["registry.test"], logFd, upstream: async () => ({ address: "127.0.0.1", port: registry.port! }) });
    const sock = `/tmp/vsock-${process.pid}`;
    const listener = Bun.listen({ unix: sock, socket: { data() {} } });
    try {
      const p = policy({ kind: "proxy", port: proxy.port });
      expect(await runAsync(p, curl("http://registry.test:443/", `-p -x '${proxy.url}'`))).toBe("200\n");
      expect(await runAsync(p, curl("http://evil.example:443/", `-p -x '${proxy.url}'`))).toBe("000\n");
      expect(await runAsync(p, curl(`http://127.0.0.1:${owner.port}/`))).toBe("000\n");
      expect(await runAsync(p, curl(`http://127.0.0.1:${registry.port}/`))).toBe("000\n");
      expect(await runAsync(p, curl("https://1.1.1.1/"))).toBe("000\n");
      expect((await runAsync(p, connect(sock))).trim()).toBe("UNIX-DENIED");
      expect((await runAsync(p, connect(DNS_SOCKET))).trim()).toBe("UNIX-DENIED");
      expect(readFileSync(join(dir, "egress.log"), "utf8")).toContain("DENY evil.example:443 host not in the allowlist");
    } finally {
      proxy.stop();
      closeSync(logFd);
      listener.stop(true);
      rmSync(sock, { force: true });
      registry.stop(true);
      owner.stop();
    }
  });
});

describe("projectEnv", () => {
  test("is built from scratch: nothing of the factory's env, the factory's own variables win", () => {
    process.env.FACTORY_CANARY = "leak";
    try {
      const env = projectEnv({ home: "/h", path: "/p:/usr/bin", user: "u", declared: { NODE_ENV: "production" }, port: 4100 });
      expect(env).toEqual({ NODE_ENV: "production", HOME: "/h", TMPDIR: "/h/tmp", PATH: "/p:/usr/bin", USER: "u", LOGNAME: "u", LANG: "en_US.UTF-8", PORT: "4100" });
      const seen = run(policy({ kind: "none" }), "env | cut -d= -f1 | sort | tr '\\n' ' '", env);
      expect(seen).not.toContain("FACTORY_CANARY");
    } finally {
      delete process.env.FACTORY_CANARY;
    }
  });

  test("a project cannot override the factory's variables or set odd names", () => {
    for (const k of ["HOME", "PATH", "PORT", "TMPDIR", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "lower", "A B"]) {
      expect(() => projectEnv({ home: "/h", path: "/p", user: "u", declared: { [k]: "x" } })).toThrow("may not set");
    }
    expect(() => projectEnv({ home: "/h", path: "/p", user: "u", proxy: "http://evil.example:8080" })).toThrow("factory egress proxy");
  });
});
