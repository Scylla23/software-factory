/**
 * Plan step 2 spike driver: the end-to-end verification run recorded in docs/spikes/02-verification.md.
 *
 *   FACTORY_CANARY=<any value> bun scripts/spike-verify.ts <pr number>
 *
 * 1. Records the PR's base and head before anything is captured, and fetches both into the fixture's checkout.
 * 2. Previews the base, sandboxed, with the canary, sibling-project, and egress probes as setup commands (network on,
 *    through the proxy), then runs the canary, sibling, git-write, keychain, and network probes beside the preview.
 * 3. In a fresh isolated Orca browser profile, checks the PR page is signed out, captures the base twice at both
 *    viewports, then previews the head and captures it once.
 * 4. Every observation is a check that keeps its own status; the attempt passes only when all of them do. Only a
 *    passed attempt is published, as one text-only comment, and only while the PR's base and head are still the
 *    recorded ones. Screenshots, logs, and records stay in the attempt's local evidence store.
 * Prints status lines only; no token, key, or cookie value is printed. Exits 1 when the attempt failed or went stale.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { loadDispatchConfig } from "../src/dispatch/config";
import { RepoClient } from "../src/github/api";
import { loadAppKey, loadAppMetadata, mintInstallationToken, TokenSource } from "../src/github/app";
import { fetchCommits } from "../src/github/fetch";
import { getPullRequest } from "../src/github/pulls";
import { publishSummary, StaleEvidenceError } from "../src/github/summary";
import { BrowserCleanupError, withVerificationProfile } from "../src/verify/browser";
import { captureChecks, commandCheck, teardownCheck } from "../src/verify/checks";
import { type EvidenceRecord, VIEWPORTS } from "../src/verify/evidence";
import { loadVerifyConfig, type Preview, PreviewError, type ProjectCommands, startPreview, tail } from "../src/verify/preview";
import { REGISTRY_HOSTS } from "../src/verify/proxy";
import { openEvidenceStore } from "../src/verify/store";
import { type Check, check, verdict } from "../src/verify/verdict";

const prArg = process.argv[2];
if (!prArg || !/^[1-9][0-9]*$/.test(prArg) || process.argv.length > 3) throw new Error("usage: spike-verify.ts <pr number>");
if (!process.env.FACTORY_CANARY) throw new Error("set FACTORY_CANARY, so the canary probe can show it does not reach the sandbox");
const pr = Number(prArg);
const OWNER = "Scylla23";
const REPO = "factory-pilot";
const HOME = userInfo().homedir;
if (!/^\/[A-Za-z0-9/._-]+$/.test(HOME)) throw new Error("the account home must be a plain path, since probes name it in a shell line");
const FACTORY = realpathSync(join(import.meta.dir, ".."));
const WORKSPACES = join(HOME, "orca/workspaces");
const PILOT = join(HOME, "orca/projects/factory-pilot");
/** The fixture's visible change, and the console error it plants on `?error=1`. */
const EXPECTED_CHANGE = "Verified change: the banner is new.";
const PLANTED_CONSOLE_ERROR = "fixture: planted console error";
const GIT_MARKER = "factory-git-write-marker";

const dispatch = loadDispatchConfig({ agentWriteRoots: [WORKSPACES] });
const config = loadVerifyConfig(dispatch, { toolDirs: [join(HOME, ".bun/bin")], toolRoots: [join(HOME, ".bun/bin")], agentWriteRoots: [WORKSPACES] });
const log = (...parts: unknown[]) => console.log(...parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))));
const script = (name: string) => readFileSync(join(FACTORY, "scripts", name), "utf8");
const sh = (body: string, ...args: string[]) => ["/bin/sh", "-c", body, ...args];
// The canary probe reads the account's files by $HOME; its $0 is its positive control, a file the sandbox may read.
const canaryArgv = sh(`HOME=${HOME}; export HOME\n${script("canary-probe.sh")}`, "package.json");

const meta = loadAppMetadata(dispatch.stateRoot);
const key = loadAppKey(meta);
const readTokens = new TokenSource(() => mintInstallationToken(meta, key, { repositories: [REPO], permissions: { contents: "read", pull_requests: "read" } }));

// 1. The revisions under test, recorded before any capture.
const recorded = await getPullRequest(new RepoClient(OWNER, REPO, readTokens), pr);
const { baseSha: base, headSha: head } = recorded;
log(`### PR #${pr}: base ${recorded.baseRef} ${base}, head ${head}`);
fetchCommits(config.executables.git, PILOT, OWNER, REPO, [base, head], await readTokens.get());

const checks: Check[] = [];
const add = (c: Check) => {
  checks.push(c);
  log(`check ${c.pass ? "PASS" : "FAIL"} ${c.name}${c.pass ? "" : `: ${c.detail.split("\n")[0]}`}`);
};
const store = openEvidenceStore(dispatch.stateRoot, crypto.randomUUID());
const logDir = join(dispatch.stateRoot, "spike-02", store.attemptId);
mkdirSync(logDir, { recursive: true, mode: 0o700 });
log(`### attempt ${store.attemptId}: evidence ${store.dir}, logs ${logDir}`);

// A sibling project's secret, planted outside the sandbox and removed at the end.
const sibling = join(HOME, "orca/projects", `factory-sibling-canary-${store.attemptId.slice(0, 8)}`);
mkdirSync(sibling, { mode: 0o700 });
const siblingValue = `FACTORY-CANARY-${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`;
writeFileSync(join(sibling, ".env"), `API_KEY=${siblingValue}\n`, { mode: 0o600, flag: "wx" });
const siblingArgv = sh(script("sibling-probe.sh"), "sibling-probe.sh", sibling, "package.json");
add(check("sibling canary readable outside", readFileSync(join(sibling, ".env"), "utf8").includes(siblingValue), "the factory itself can read it, so a denial means something"));

// Another loopback listener the preview must not reach.
const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("other") });
const otherUrl = `http://127.0.0.1:${other.port}/`;
add(check("other loopback port open outside", (await fetch(otherUrl, { signal: AbortSignal.timeout(5_000) }).then((r) => r.status, () => 0)) === 200));
const keychainRc = Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-s", "software-factory.github-app.pem"], { stdout: "ignore", stderr: "ignore", env: { PATH: "/usr/bin:/bin" }, timeout: 30_000 }).exitCode;
add(check("keychain item findable outside", keychainRc === 0, `rc ${keychainRc}`));

const SETUP_PROBES = ["canary probe (setup)", "sibling probe (setup)", "network probe (setup)"] as const;
const project = (probes: boolean): ProjectCommands => ({
  setup: [["bun", "install", "--frozen-lockfile"], ...(probes ? [canaryArgv, siblingArgv, sh(script("network-probe.sh"), "network-probe.sh", "setup", "https://registry.npmjs.org/", "https://example.com/")] : [])],
  egress: REGISTRY_HOSTS.npm,
  preview: ["bun", "server.ts"],
  readyPath: "/health",
  portRange: [4100, 4199],
});

const previews = new Set<Preview>();
async function preview(sha: string, which: "base" | "head"): Promise<Preview | null> {
  const t0 = Date.now();
  try {
    const p = await startPreview({ id: crypto.randomUUID(), taskKey: `spike-02-${which}`, repo: PILOT, sha, logDir, project: project(which === "base"), setupTimeoutMs: 180_000, readyTimeoutMs: 20_000, maxLifetimeMs: 900_000 }, config);
    previews.add(p);
    log(`### ${which} preview ${sha.slice(0, 12)} ready on ${p.origin} in ${Date.now() - t0}ms (spawn to 200: ${p.readyMs}ms)`);
    add(check(`${which} preview starts`, true));
    // Setup stops at the first command that does not exit 0, so a started preview means every setup probe passed.
    if (which === "base") for (const [i, name] of SETUP_PROBES.entries()) {
      const logPath = p.logs.find((l) => l.endsWith(`.setup-${i + 1}.log`))!;
      add(check(name, true, `exit 0\n${tail(logPath, 800)}`));
    }
    return p;
  } catch (err) {
    const detail = err instanceof PreviewError ? `${err.message}\n${err.logTail}` : (err as Error).message;
    add(check(`${which} preview starts`, false, detail));
    return null;
  }
}

async function stop(p: Preview, which: "base" | "head"): Promise<void> {
  previews.delete(p);
  add(teardownCheck(`${which} preview teardown`, await p.stop()));
}

/** Markers the git-write probe may have left in the shared git dirs; any one is a failed check, and is removed. */
function gitMarkers(worktree: string): string[] {
  const r = Bun.spawnSync([config.executables.git, "-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"], { stderr: "ignore", timeout: 30_000 });
  const [common, admin] = r.stdout.toString().trim().split("\n");
  if (r.exitCode !== 0 || !common || !admin) return [`git rev-parse failed in ${worktree}`];
  const found = [join(common, "hooks", GIT_MARKER), join(common, "objects", GIT_MARKER), join(common, GIT_MARKER), join(admin, GIT_MARKER)].filter((m) => existsSync(m));
  for (const m of found) rmSync(m, { force: true });
  return found;
}

async function probesBeside(p: Preview): Promise<void> {
  const run = async (name: string, slug: string, argv: string[], network: "none" | "serve") => add(commandCheck(name, await p.run(argv, { network, name: slug, timeoutMs: 120_000 })));
  await run("canary probe (serve)", "probe-canary-serve", canaryArgv, "serve");
  await run("canary probe (none)", "probe-canary-none", canaryArgv, "none");
  await run("sibling probe (serve)", "probe-sibling-serve", siblingArgv, "serve");
  await run("git-write probe (serve)", "probe-git-serve", sh(script("git-write-probe.sh"), "git-write-probe.sh"), "serve");
  const markers = gitMarkers(p.worktree);
  add(check("git-write markers absent", markers.length === 0, markers.join(", ")));
  await run("keychain probe (serve)", "probe-keychain-serve", sh("/usr/bin/security find-generic-password -s software-factory.github-app.pem >/dev/null 2>&1; rc=$?; echo KEYCHAIN-RC=$rc; [ $rc -ne 0 ]"), "serve");
  const net = (mode: string) => sh(script("network-probe.sh"), "network-probe.sh", mode, `${p.origin}/health`, otherUrl, "https://example.com/");
  await run("network probe (serve)", "probe-net-serve", net("serve"), "serve");
  await run("network probe (none)", "probe-net-none", net("none"), "none");
  const s = p.serving();
  add(check("base preview serving after probes", s.ok, s.ok ? "" : s.reason));
}

let records: EvidenceRecord[] = [];
let failure: unknown = null;
try {
  const p1 = await preview(base, "base");
  if (p1) {
    await probesBeside(p1);
    try {
      records = await withVerificationProfile({ orcaPath: config.executables.orca, worktree: `path:${FACTORY}` }, async (browser) => {
        const session = await browser.sessionAt(`https://github.com/${OWNER}/${REPO}/pull/${pr}`);
        add(check("PR page signed out", !session.signedIn, `logged_in ${session.loggedIn ?? "absent"}, cookies ${session.cookieNames.join(" ") || "none"}`));
        const capture = async (p: Preview, run: string, sha: string): Promise<EvidenceRecord[]> => {
          const out: EvidenceRecord[] = [];
          for (const v of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
            const r = await browser.capture({ url: `${p.origin}/?error=1`, viewport: v, store, name: `${run}-${v.name}`, acId: "AC-1", commitSha: sha, serving: p.serving });
            log(`capture ${r.name}: sha256 ${r.screenshotSha256.slice(0, 16)}, console errors ${r.consoleErrors.length}, other origins ${JSON.stringify(r.externalOrigins)}`);
            out.push(r);
          }
          return out;
        };
        const first = await capture(p1, "base-a", base);
        const second = await capture(p1, "base-b", base);
        await stop(p1, "base");
        const p2 = await preview(head, "head");
        if (!p2) return [...first, ...second];
        const after = await capture(p2, "head", head);
        await stop(p2, "head");
        for (const c of captureChecks({ first, second, after, viewports: ["desktop", "mobile"], expectedChange: EXPECTED_CHANGE, plantedConsoleError: PLANTED_CONSOLE_ERROR })) add(c);
        return [...first, ...second, ...after];
      });
      add(check("browser profile removed", true));
    } catch (err) {
      add(check(err instanceof BrowserCleanupError ? "browser profile removed" : "browser capture", false, (err as Error).message));
    }
  }
} catch (err) {
  failure = err;
  add(check("attempt ran to the end", false, (err as Error).message));
} finally {
  for (const p of [...previews]) await stop(p, p.sha === base ? "base" : "head").catch((e: Error) => log(`### stop failed: ${e.message}`));
  await other.stop(true);
  rmSync(sibling, { recursive: true, force: true });
  log(`### sibling canary removed: ${!existsSync(sibling)}`);
}

const v = verdict(checks);
store.putJson("records.json", { pr, base, head, baseRef: recorded.baseRef, records });
store.putJson("checks.json", { verdict: v, checks });
log(`### verdict ${v.pass ? "PASS" : "FAIL"}${v.pass ? "" : `: ${v.failed.join(", ")}`}`);
if (!v.pass) {
  if (failure) console.error(failure);
  log("### not published: the attempt did not pass");
  process.exit(1);
}

const writeTokens = new TokenSource(() => mintInstallationToken(meta, key, { repositories: [REPO], permissions: { pull_requests: "write" } }));
try {
  const published = await publishSummary(new RepoClient(OWNER, REPO, writeTokens), { pr, attemptId: store.attemptId, base, head, checks, captures: records, evidenceDir: store.dir }, { botLogin: `${meta.slug}[bot]` });
  log("### published", published);
} catch (err) {
  if (!(err instanceof StaleEvidenceError)) throw err;
  log(`### stale, not published: ${err.message}`);
  process.exit(1);
}
