import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NetworkMode, projectEnv, type ProjectSandbox, sandboxArgv, sandboxProfile } from "../src/verify/sandbox";
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
  denyRead: [join(dir, "secret")],
  denyWrite: [gitDir],
  writable: [writable],
  network,
  ...extra,
});

/** Runs `script` with /bin/sh under the sandbox and returns stdout. */
function run(p: ProjectSandbox, script: string, env: Record<string, string> = { PATH: `${BUN_DIR}:/usr/bin:/bin` }): string {
  const r = Bun.spawnSync(sandboxArgv("/usr/bin/sandbox-exec", p, ["/bin/sh", "-c", script]), { env, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
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

describe("files", () => {
  test("denied paths cannot be read, directly or by search, while other files can", () => {
    const out = run(policy({ kind: "none" }), `cat '${secret}' 2>&1; grep -r SECRET '${dir}/secret' 2>&1; ls '${dir}/secret' 2>&1; cat /etc/hosts >/dev/null && echo READ-OTHER-OK`);
    expect(out).not.toContain("SECRET-VALUE");
    expect(out).toContain("Operation not permitted");
    expect(out).toContain("READ-OTHER-OK");
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

describe("network", () => {
  const curl = (url: string) => `/usr/bin/curl -sS -m 3 -o /dev/null -w '%{http_code}' ${url} 2>/dev/null; echo`;

  test("serve: binds and accepts on its own port only, with no outbound connection even to loopback", async () => {
    const owner = ownerService();
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    try {
      const p = policy({ kind: "serve", port });
      const proc = Bun.spawn(sandboxArgv("/usr/bin/sandbox-exec", p, [process.execPath, "-e", `Bun.serve({hostname:"127.0.0.1",port:${port},fetch:()=>new Response("in-sandbox")}); setTimeout(()=>process.exit(0), 8000)`]), { env: { PATH: "/usr/bin:/bin" }, stdout: "ignore", stderr: "pipe" });
      let body = "";
      for (let i = 0; i < 50 && body !== "in-sandbox"; i++) {
        await Bun.sleep(100);
        body = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text(), () => "");
      }
      proc.kill();
      expect(body).toBe("in-sandbox");
      expect(run(p, curl(`http://127.0.0.1:${owner.port}/`))).toBe("000\n");
      const other = run(p, `${process.execPath} -e 'try { Bun.serve({hostname:"127.0.0.1",port:${port + 1},fetch:()=>new Response("")}); console.log("BOUND") } catch (e) { console.log("BIND-DENIED") }'`);
      expect(other.trim()).toBe("BIND-DENIED");
    } finally {
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

  test("outbound: no loopback and no unix sockets (ssh-agent, Docker, Orca), but the DNS socket stays open", async () => {
    const owner = ownerService();
    const sock = `/tmp/vsock-${process.pid}`;
    const listener = Bun.listen({ unix: sock, socket: { data() {} } });
    try {
      const p = policy({ kind: "outbound" });
      expect(run(p, curl(`http://127.0.0.1:${owner.port}/`))).toBe("000\n");
      expect(run(p, curl(`http://localhost:${owner.port}/`))).toBe("000\n");
      const connect = (path: string) => `${process.execPath} -e 'try { await Bun.connect({unix:"${path}",socket:{data(){}}}); console.log("UNIX-OPEN") } catch { console.log("UNIX-DENIED") } process.exit(0)'`;
      expect(run(p, connect(sock)).trim()).toBe("UNIX-DENIED");
      // Name resolution goes through the system DNS socket, the one unix socket allowed; without it, installs fail.
      expect(run(p, connect(DNS_SOCKET)).trim()).toBe("UNIX-OPEN");
      expect(run(policy({ kind: "serve", port: 20_000 }), connect(DNS_SOCKET)).trim()).toBe("UNIX-DENIED");
    } finally {
      listener.stop(true);
      rmSync(sock, { force: true });
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
    for (const k of ["HOME", "PATH", "PORT", "TMPDIR", "lower", "A B"]) {
      expect(() => projectEnv({ home: "/h", path: "/p", user: "u", declared: { [k]: "x" } })).toThrow("may not set");
    }
  });
});
