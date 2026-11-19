import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tempRoots } from "../src/dispatch/config";
import type { VerifyConfig } from "../src/verify/preview";

/** Directory of the running Bun, so sandboxed project commands can run `bun` from a verified tool PATH. */
export const BUN_DIR = dirname(realpathSync(process.execPath));

export interface VerifyEnv {
  /** Account home in the config: deny entries point here; holds a planted `.ssh/id_test`. */
  home: string;
  stateRoot: string;
  logDir: string;
  /** Holds test repositories; outside every temp root, like a real project checkout. */
  repos: string;
  /** Receives preview worktrees and homes; under the system temp dir, like the spike. */
  previewRoot: string;
  config: VerifyConfig;
  cleanup: () => void;
}

export function makeVerifyEnv(): VerifyEnv {
  const state = join(import.meta.dir, ".state");
  mkdirSync(state, { recursive: true });
  const home = mkdtempSync(join(state, "vhome-"));
  mkdirSync(join(home, ".ssh"), { mode: 0o700 });
  writeFileSync(join(home, ".ssh", "id_test"), "PLANTED-SSH-SECRET\n", { mode: 0o600 });
  const stateRoot = mkdtempSync(join(state, "vstate-"));
  const logDir = join(stateRoot, "logs");
  mkdirSync(logDir, { mode: 0o700 });
  const repos = mkdtempSync(join(state, "vrepos-"));
  const previewRoot = realpathSync(mkdtempSync(join(tmpdir(), "verify-previews-")));
  const config: VerifyConfig = {
    executables: { git: "/usr/bin/git", ps: "/bin/ps", lsof: "/usr/sbin/lsof", orca: "/usr/bin/false", sandboxExec: "/usr/bin/sandbox-exec" },
    accountHome: home,
    stateRoot,
    harnessHomes: [],
    toolPath: `${BUN_DIR}:/usr/bin:/bin`,
    toolRoots: [BUN_DIR],
    untrustedRoots: tempRoots(),
  };
  return {
    home,
    stateRoot,
    logDir,
    repos,
    previewRoot,
    config,
    cleanup: () => {
      for (const d of [home, stateRoot, repos, previewRoot]) rmSync(d, { recursive: true, force: true });
    },
  };
}

const GIT_ENV = { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" };

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["/usr/bin/git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A repo whose commits each write the given files; returns the commit ids in order. */
export function makeRepo(parent: string, name: string, commits: readonly Record<string, string>[]): { path: string; shas: string[] } {
  const path = join(parent, name);
  mkdirSync(path);
  git(path, "init", "-q", "-b", "main");
  const shas: string[] = [];
  for (const [i, files] of commits.entries()) {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), content);
    }
    git(path, "add", "-A");
    git(path, "commit", "-q", "-m", `commit ${i}`);
    shas.push(git(path, "rev-parse", "HEAD"));
  }
  return { path, shas };
}

/** A minimal app: `/health` answers with HEALTH_STATUS (default 200); the page says `marker`. */
export function serverSource(marker: string, opts: { healthStatus?: number; exitCode?: number; exitAfterMs?: number } = {}): string {
  if (opts.exitCode !== undefined) return `process.exit(${opts.exitCode});\n`;
  return `${opts.exitAfterMs ? `setTimeout(() => process.exit(0), ${opts.exitAfterMs});\n` : ""}Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch(req) {
  const { pathname } = new URL(req.url);
  if (pathname === "/health") return new Response("ok", { status: ${opts.healthStatus ?? 200} });
  return new Response(${JSON.stringify(marker)});
} });
`;
}

/** Every HTTP call in tests is bounded, so a stuck server fails the test instead of hanging it. */
export function bounded(url: string, ms = 5_000): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(ms) });
}

/** An app that tries, server side, to call itself, a loopback service on `ownerPort`, and an outside host. */
export function probingServerSource(ownerPort: number): string {
  return `const port = Number(process.env.PORT);
const tryFetch = (u) => fetch(u, { signal: AbortSignal.timeout(3000) }).then((r) => r.text(), () => "DENIED");
Bun.serve({ hostname: "127.0.0.1", port, async fetch(req) {
  const { pathname } = new URL(req.url);
  if (pathname === "/health") return new Response("ok");
  if (pathname === "/api") return new Response("api");
  if (pathname === "/self") return new Response("self:" + await tryFetch(\`http://127.0.0.1:\${port}/api\`));
  if (pathname === "/lateral") return new Response("lateral:" + await tryFetch("http://127.0.0.1:${ownerPort}/"));
  if (pathname === "/out") return new Response("out:" + await tryFetch("http://1.1.1.1/"));
  return new Response("probing");
} });
`;
}
