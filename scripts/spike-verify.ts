/**
 * Plan step 2 spike driver: the end-to-end verification run recorded in docs/spikes/02-verification.md.
 *
 *   FACTORY_CANARY=<any value> bun scripts/spike-verify.ts <before sha> <after sha> <pr number>
 *
 * 1. Previews each commit of the factory-pilot fixture from the factory-controlled checkout, sandboxed.
 * 2. Runs the canary, git-write, keychain, and network probes inside the preview's own sandbox.
 * 3. Opens a fresh isolated Orca browser profile, proves it has no GitHub session, and captures evidence at both
 *    viewports, twice on the before commit (stability) and once on the after commit.
 * 4. Publishes the evidence to the draft PR through the GitHub App.
 * Prints status lines only; no token, key, or cookie value is printed.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { loadDispatchConfig } from "../src/dispatch/config";
import { RepoClient } from "../src/github/api";
import { loadAppKey, loadAppMetadata, mintInstallationToken } from "../src/github/app";
import { fetchCommits } from "../src/github/fetch";
import { publishEvidence } from "../src/github/evidence";
import { orcaJson } from "../src/orca/cli";
import { captureEvidence, createVerificationProfile, deleteVerificationProfile, githubSession, withVerificationTab } from "../src/verify/browser";
import { type EvidenceRecord, VIEWPORTS } from "../src/verify/evidence";
import { loadVerifyConfig, type Preview, type ProjectCommands, startPreview } from "../src/verify/preview";
import { REGISTRY_HOSTS } from "../src/verify/proxy";

const [before, after, prArg] = process.argv.slice(2);
if (!before || !after || !prArg) throw new Error("usage: spike-verify.ts <before sha> <after sha> <pr number>");
const pr = Number(prArg);
const OWNER = "Scylla23";
const REPO = "factory-pilot";
const HOME = userInfo().homedir;
const FACTORY = realpathSync(join(import.meta.dir, ".."));
const WORKSPACES = join(HOME, "orca/workspaces");
const PILOT = join(HOME, "orca/projects/factory-pilot");

const dispatch = loadDispatchConfig({ agentWriteRoots: [WORKSPACES] });
const config = loadVerifyConfig(dispatch, { toolDirs: [join(HOME, ".bun/bin")], toolRoots: [join(HOME, ".bun/bin")], agentWriteRoots: [WORKSPACES] });
const spikeDir = join(dispatch.stateRoot, "spike-02");
const runDir = join(spikeDir, `run-${Date.now()}`);
const logDir = join(runDir, "logs");
const evidenceDir = join(runDir, "evidence");
for (const d of [spikeDir, runDir, logDir, evidenceDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
const previewRoot = realpathSync(mkdtempSync(join(tmpdir(), "factory-previews-")));
const log = (...parts: unknown[]) => console.log(...parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))));

const project: ProjectCommands = {
  setup: [["bun", "install", "--frozen-lockfile"]],
  egress: REGISTRY_HOSTS.npm,
  preview: ["bun", "server.ts"],
  readyPath: "/health",
  portRange: [4100, 4199],
};

const meta = loadAppMetadata(dispatch.stateRoot);
const key = loadAppKey(meta);
fetchCommits(config.executables.git, PILOT, OWNER, REPO, [before, after], await mintInstallationToken(meta, key, { repositories: [REPO], permissions: { contents: "read" } }));
log("### fetched", { before, after }, "into", PILOT);

const keychainRc = () => Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-s", "software-factory.github-app.pem"], { stdout: "ignore", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } }).exitCode;
log("### keychain baseline outside any sandbox: rc", keychainRc(), "(0 = the App key item exists and is findable)");

async function preview(sha: string, taskKey: string): Promise<Preview> {
  const t0 = Date.now();
  const p = await startPreview({ id: crypto.randomUUID(), taskKey, repo: PILOT, sha, previewRoot, logDir, project, setupTimeoutMs: 180_000, readyTimeoutMs: 20_000, maxLifetimeMs: 900_000 }, config);
  log(`### preview ${sha.slice(0, 12)} ready on ${p.origin} in ${Date.now() - t0}ms (spawn to 200: ${p.readyMs}ms), worktree ${p.worktree}`);
  log("setup log:", readFileSync(p.logs[0]!, "utf8").trim().split("\n").slice(-2).join(" | "));
  return p;
}

async function probes(p: Preview): Promise<void> {
  const sh = (name: string, network: "none" | "serve", script: string) => p.run(["/bin/sh", "-c", script], { network, name, timeoutMs: 120_000 });
  const show = async (label: string, r: Awaited<ReturnType<typeof sh>>) => {
    log(`--- ${label}: exit ${r.exitCode}, quarantine ${JSON.stringify(r.quarantineReasons)}`);
    console.log(readFileSync(r.logPath, "utf8").trimEnd());
  };
  await show("canary probe, preview profile", await sh("probe-canary-serve", "serve", `HOME=${HOME} sh ${FACTORY}/scripts/canary-probe.sh; echo EXIT=$?`));
  await show("canary probe, no-network profile", await sh("probe-canary-setup", "none", `HOME=${HOME} sh ${FACTORY}/scripts/canary-probe.sh 2>&1 | grep -cE '^DENIED' | sed 's/^/DENIED-COUNT /'; HOME=${HOME} sh ${FACTORY}/scripts/canary-probe.sh 2>&1 | grep -E 'READABLE|MISSING|INDIRECT|NET-|RESULT|ENV-'`));
  await show("git-write probe, preview profile", await sh("probe-git-serve", "serve", `sh ${FACTORY}/scripts/git-write-probe.sh 2>&1 | grep -v '^xcrun\\|confstr'; echo EXIT=$?`));
  await show("keychain, preview profile", await sh("probe-keychain", "serve", `/usr/bin/security find-generic-password -s software-factory.github-app.pem >/dev/null 2>&1; echo KEYCHAIN-RC=$?`));
  const outbound = `curl -sS -m 8 -o /dev/null -w 'HTTPS %{http_code}\\n' https://registry.npmjs.org/ 2>&1 | tail -1; curl -sS -m 3 -o /dev/null -w 'LOOPBACK-SELF %{http_code}\\n' ${p.origin}/health 2>&1 | tail -1`;
  await show("network, preview profile (serve)", await sh("probe-net-serve", "serve", outbound));
  await show("network, no-network profile", await sh("probe-net-setup", "none", outbound));
}

let profileId: string | null = null;
const previews: Preview[] = [];
try {
  const p1 = await preview(before, "spike-02-before");
  previews.push(p1);
  await probes(p1);
  const still = await fetch(`${p1.origin}/health`).then((r) => r.status, (e: Error) => e.message);
  log(`### preview still serving after the probes: ${still}`);

  profileId = await createVerificationProfile(config.executables.orca, `factory-verify-${crypto.randomUUID().slice(0, 8)}`);
  const target = { orcaPath: config.executables.orca, worktree: `path:${FACTORY}`, profileId };
  log(`### verification profile ${profileId}`);
  const prUrl = `https://github.com/${OWNER}/${REPO}/pull/${pr}`;
  await withVerificationTab(target, prUrl, async (page) => {
    const tab = await orcaJson(target.orcaPath, ["tab", "show", "--page", page]);
    const t = tab.tab as Record<string, unknown>;
    log("clean profile on the private PR:", { title: t.title, profileId: t.profileId }, "github cookies:", await githubSession(target.orcaPath, page));
  });

  const capture = async (p: Preview, run: string, sha: string): Promise<EvidenceRecord[]> => {
    const out: EvidenceRecord[] = [];
    for (const v of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
      const r = await captureEvidence({ target, url: `${p.origin}/?error=1`, viewport: v, outDir: evidenceDir, name: `${run}-${v.name}`, acId: "AC-1", commitSha: sha });
      log(`capture ${r.name}: sha256 ${r.screenshotSha256.slice(0, 16)}, console ${JSON.stringify(r.consoleErrors)}, failed ${JSON.stringify(r.networkFailures.map((f) => `${f.method} ${new URL(f.url).pathname} ${f.status}`))}, banner text ${r.pageText.includes("Verified change: the banner is new.")}, stabilized ${JSON.stringify(r.stabilized)}`);
      out.push(r);
    }
    return out;
  };
  const beforeA = await capture(p1, "before-a", before);
  const beforeB = await capture(p1, "before-b", before);
  for (const [a, b] of beforeA.map((r, i) => [r, beforeB[i]!] as const)) log(`stability ${a.viewport.name}: ${a.screenshotSha256 === b.screenshotSha256 ? "IDENTICAL" : "DIFFERENT"}`);
  log("### stop before preview:", await p1.stop());
  previews.pop();

  const p2 = await preview(after, "spike-02-after");
  previews.push(p2);
  const afterRecords = await capture(p2, "after", after);
  for (const [a, b] of beforeA.map((r, i) => [r, afterRecords[i]!] as const)) log(`before/after ${a.viewport.name}: ${a.screenshotSha256 === b.screenshotSha256 ? "IDENTICAL" : "DIFFERENT"}`);
  log("### stop after preview:", await p2.stop());
  previews.pop();

  const token = await mintInstallationToken(meta, key, { repositories: [REPO], permissions: { contents: "write", pull_requests: "write", issues: "write" } });
  log(`### publishing with a token scoped to ${JSON.stringify(token.repositories)} ${JSON.stringify(token.permissions)}, printed as ${String(token)}`);
  const head = (await new RepoClient(OWNER, REPO, token).request<{ head: { sha: string } }>("GET", `/repos/${OWNER}/${REPO}/pulls/${pr}`))!.head.sha;
  const published = await publishEvidence(new RepoClient(OWNER, REPO, token), {
    pr,
    headSha: head,
    attemptId: crypto.randomUUID(),
    groups: [
      { title: `Before (${before.slice(0, 12)})`, records: beforeA },
      { title: `After (${after.slice(0, 12)})`, records: afterRecords },
      { title: "Repeat of before (stability)", records: beforeB },
    ],
  });
  log("### published", published);
} finally {
  for (const p of previews) log("### stop (cleanup):", await p.stop());
  if (profileId) {
    await deleteVerificationProfile(config.executables.orca, profileId);
    log(`### deleted profile ${profileId}`);
  }
  try {
    rmdirSync(previewRoot); // only when empty: a quarantined preview stays for inspection
  } catch (err) {
    log("### preview root kept:", (err as Error).message);
  }
  log("### evidence dir", evidenceDir);
}
