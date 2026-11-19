import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { RepoClient } from "../src/github/api";
import { InstallationToken, TokenSource } from "../src/github/app";
import { EvidenceGateError, publishSummary, summaryComment } from "../src/github/summary";
import { captureChecks, commandCheck, teardownCheck } from "../src/verify/checks";
import { type EvidenceRecord, VIEWPORTS } from "../src/verify/evidence";
import type { CommandResult, TeardownReport } from "../src/verify/preview";
import { verdict } from "../src/verify/verdict";

const SCRIPTS = join(import.meta.dir, "..", "scripts");
let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "verify-checks-")));
});
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

function result(extra: Partial<CommandResult> = {}): CommandResult {
  const logPath = join(dir, `probe-${Math.random()}.log`);
  writeFileSync(logPath, "DENIED /x\nRESULT PASS\n");
  return { exitCode: 0, stopped: null, quarantineReasons: [], logPath, ...extra };
}

describe("probe checks", () => {
  test("a probe passes only on its own exit 0, and the check keeps the status and the log's end", () => {
    const ok = commandCheck("canary probe (serve)", result());
    expect(ok.pass).toBe(true);
    expect(ok.detail).toBe("exit 0\nDENIED /x\nRESULT PASS\n");
    for (const [r, status] of [
      [result({ exitCode: 1 }), "exit 1"],
      [result({ exitCode: 2 }), "exit 2"],
      [result({ exitCode: null }), "killed by a signal"],
      [result({ exitCode: 0, stopped: "timed_out" }), "timed_out"],
      [result({ exitCode: null, stopped: "cancelled" }), "cancelled"],
    ] as const) {
      const c = commandCheck("canary probe (serve)", r);
      expect(c.pass).toBe(false);
      expect(c.detail.startsWith(`${status}\n`)).toBe(true);
    }
    const left = commandCheck("git-write probe", result({ quarantineReasons: ["pid 7 survived"] }));
    expect(left.pass).toBe(false);
    expect(left.detail.startsWith("exit 0; left behind: pid 7 survived\n")).toBe(true);
  });

  test("a probe log published as a check never shows part of the account name, wherever its excerpt starts", () => {
    const home = homedir();
    const user = userInfo().username;
    const min = Math.min(5, user.length);
    const fragments: string[] = [];
    for (let i = 0; i + min <= user.length; i++) for (let j = i + min; j <= user.length; j++) fragments.push(user.slice(i, j));
    const publish = (log: string) => {
      const c = commandCheck("canary probe (serve)", { exitCode: 0, stopped: null, quarantineReasons: [], logPath: log });
      return { detail: c.detail, body: summaryComment({ pr: 2, attemptId: crypto.randomUUID(), base: "8".repeat(40), head: "9".repeat(40), checks: [c], captures: [record("after-desktop", { commitSha: "9".repeat(40) })], evidenceDir: "/x" }) };
    };
    const log = join(dir, "canary.log");
    // The excerpt's window starts at every offset across lines naming paths under the home, as in the leaked comment.
    const paths = Array.from({ length: 30 }, (_, i) => `DENIED ${home}/.codex/file-${i}.json`).join("\n");
    for (let pad = 0; pad < 80; pad++) {
      writeFileSync(log, `${paths}\n${"p".repeat(pad)}\nRESULT PASS\n`);
      const { detail, body } = publish(log);
      expect(detail).toContain("DENIED");
      for (const f of fragments) expect(body).not.toContain(f);
    }
    // A last line longer than the excerpt is never cut into.
    // Sized so the 800-byte window would start in the middle of the home path.
    writeFileSync(log, `ok\nDENIED ${home}/${"x".repeat(800 - Math.floor(home.length / 2))}\n`);
    const long = publish(log);
    expect(long.detail).toContain("last line longer than");
    for (const f of fragments) expect(long.body).not.toContain(f);
  });

  test("a teardown passes only when it removed everything and nothing may still run", () => {
    const clean: TeardownReport = { cleanup: null, noKnownSurvivors: true, quarantineReasons: [], removed: true };
    expect(teardownCheck("base preview teardown", clean).pass).toBe(true);
    expect(teardownCheck("base preview teardown", { ...clean, removed: false }).pass).toBe(false);
    expect(teardownCheck("base preview teardown", { ...clean, noKnownSurvivors: false }).pass).toBe(false);
    const q = teardownCheck("base preview teardown", { ...clean, quarantineReasons: ["cleanup failed: EBUSY"] });
    expect(q.pass).toBe(false);
    expect(q.detail).toContain("cleanup failed: EBUSY");
  });

  test("a failed probe stops the publish before any GitHub call", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      return new Response("{}", { status: 200 });
    };
    const tokens = new TokenSource(async () => new InstallationToken("t", new Date(Date.now() + 3_600_000), ["factory-pilot"], {}));
    const client = new RepoClient("Scylla23", "factory-pilot", tokens, fetchImpl);
    const checks = [commandCheck("canary probe (setup)", result()), commandCheck("canary probe (serve)", result({ exitCode: 1 }))];
    expect(verdict(checks)).toEqual({ pass: false, failed: ["canary probe (serve)"] });
    const s = { pr: 2, attemptId: crypto.randomUUID(), base: "8".repeat(40), head: "9".repeat(40), checks, captures: [record("after-desktop", { commitSha: "9".repeat(40) })], evidenceDir: "/x" };
    await expect(publishSummary(client, s, { botLogin: "b[bot]" })).rejects.toBeInstanceOf(EvidenceGateError);
    expect(calls).toEqual([]);
  });
});

function record(name: string, extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    acId: "AC-1", name, commitSha: "8".repeat(40), url: "http://127.0.0.1:4100/?error=1", origin: "http://127.0.0.1:4100", browserEgress: "unrestricted", externalOrigins: [], viewport: VIEWPORTS.desktop, screenshotPath: "/dev/null", screenshotSha256: "a".repeat(64), screenshotBytes: 1,
    consoleErrors: ["fixture: planted console error"], networkFailures: [], pageText: "Fixture", truncated: { console: false, network: false, pageText: false }, stabilized: null, capturedAt: "t", ...extra,
  };
}

describe("capture checks", () => {
  const BANNER = "the banner is new";
  const runs = (over: { first?: Partial<EvidenceRecord>; second?: Partial<EvidenceRecord>; after?: Partial<EvidenceRecord>; mobile?: boolean } = {}) => {
    const set = (run: string, extra: Partial<EvidenceRecord>) => [
      record(`${run}-desktop`, extra),
      ...(over.mobile === false ? [] : [record(`${run}-mobile`, { viewport: VIEWPORTS.mobile, screenshotSha256: run === "after" ? "d".repeat(64) : "c".repeat(64), ...extra })]),
    ];
    return captureChecks({
      first: set("first", over.first ?? {}),
      second: set("second", over.second ?? {}),
      after: set("after", { screenshotSha256: "b".repeat(64), pageText: `Fixture ${BANNER}`, ...over.after }),
      viewports: ["desktop", "mobile"],
      expectedChange: BANNER,
      plantedConsoleError: "planted console error",
    });
  };
  const failed = (checks: ReturnType<typeof captureChecks>) => verdict(checks).failed;

  test("repeatable base, a different head, the change on the head only, and the planted error seen: all pass", () => {
    const checks = runs({ after: { screenshotSha256: "b".repeat(64), pageText: `Fixture ${BANNER}` } });
    expect(checks.map((c) => c.name)).toEqual([
      "base capture repeatable (desktop)", "base and head differ (desktop)", "change on head only (desktop)", "planted console error seen (desktop)",
      "base capture repeatable (mobile)", "base and head differ (mobile)", "change on head only (mobile)", "planted console error seen (mobile)",
    ]);
    expect(failed(checks)).toEqual([]);
  });

  test("each way a capture can fail fails its own check", () => {
    expect(failed(runs({ second: { screenshotSha256: "e".repeat(64) } }))).toEqual(["base capture repeatable (desktop)", "base capture repeatable (mobile)"]);
    expect(failed(runs({ after: { screenshotSha256: "a".repeat(64), pageText: `x ${BANNER}` } }))).toEqual(["base and head differ (desktop)"]);
    expect(failed(runs({ after: { screenshotSha256: "b".repeat(64), pageText: "no change" } }))).toEqual(["change on head only (desktop)", "change on head only (mobile)"]);
    expect(failed(runs({ second: { pageText: BANNER } }))).toEqual(["change on head only (desktop)", "change on head only (mobile)"]);
    expect(failed(runs({ second: { consoleErrors: [] } }))).toEqual(["planted console error seen (desktop)", "planted console error seen (mobile)"]);
    expect(failed(runs({ mobile: false }))).toEqual(["captures complete (mobile)"]);
  });
});

/** Runs a probe script with a fake curl that answers only the requests listed in `reach` ("<flag>|<url>"). */
function probe(script: string, args: string[], reach: string[], env: Record<string, string> = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
flag=""
for a in "$@"; do case $a in --noproxy) flag=noproxy ;; -x) flag=x ;; esac; url=$a; done
key="$flag|$url"
printf '%s\\n' "$FAKE_REACH" | grep -qxF -- "$key" || exit 7
printf 200
`,
  );
  chmodSync(join(bin, "curl"), 0o755);
  const r = Bun.spawnSync(["/bin/sh", join(SCRIPTS, script), ...args], { env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_REACH: reach.join("\n"), ...env }, cwd: dir, timeout: 30_000 });
  return { code: r.exitCode, out: r.stdout.toString() };
}

describe("network probe", () => {
  const SELF = "http://127.0.0.1:4100/health";
  const OTHER = "http://127.0.0.1:4999/";
  const OUT = "https://example.com/";
  const PROXY = { HTTPS_PROXY: "http://factory:0123abcd@127.0.0.1:5555" };
  const ALLOWED = "https://registry.npmjs.org/";

  test("beside the preview: its own port only", () => {
    expect(probe("network-probe.sh", ["serve", SELF, OTHER, OUT], [`|${SELF}`])).toEqual({
      code: 0,
      out: "REACHED the preview's own port 200\nBLOCKED another loopback port\nBLOCKED an outside host\nBLOCKED a public address\nRESULT PASS\n",
    });
    expect(probe("network-probe.sh", ["serve", SELF, OTHER, OUT], [`|${SELF}`, `|${OTHER}`]).code).toBe(1);
    expect(probe("network-probe.sh", ["serve", SELF, OTHER, OUT], [`|${SELF}`, "|https://1.1.1.1/"]).code).toBe(1);
    expect(probe("network-probe.sh", ["serve", SELF, OTHER, OUT], []).code).toBe(2);
    // A leak wins over inconclusive.
    expect(probe("network-probe.sh", ["serve", SELF, OTHER, OUT], [`|${OUT}`]).code).toBe(1);
  });

  test("no network: not even the preview's port", () => {
    expect(probe("network-probe.sh", ["none", SELF, OTHER, OUT], []).code).toBe(0);
    expect(probe("network-probe.sh", ["none", SELF, OTHER, OUT], [`|${SELF}`]).code).toBe(1);
  });

  test("setup: the proxy reaches allowed hosts only, nothing bypasses it, and it wants its credential", () => {
    const pass = probe("network-probe.sh", ["setup", ALLOWED, OUT], [`|${ALLOWED}`], PROXY);
    expect(pass.code).toBe(0);
    expect(pass.out).not.toContain("0123abcd");
    expect(probe("network-probe.sh", ["setup", ALLOWED, OUT], [`|${ALLOWED}`, `|${OUT}`], PROXY).code).toBe(1);
    expect(probe("network-probe.sh", ["setup", ALLOWED, OUT], [`|${ALLOWED}`, `noproxy|${ALLOWED}`], PROXY).code).toBe(1);
    expect(probe("network-probe.sh", ["setup", ALLOWED, OUT], [`|${ALLOWED}`, "noproxy|https://1.1.1.1/"], PROXY).code).toBe(1);
    expect(probe("network-probe.sh", ["setup", ALLOWED, OUT], [`|${ALLOWED}`, `x|${ALLOWED}`], PROXY).code).toBe(1);
    expect(probe("network-probe.sh", ["setup", ALLOWED, OUT], [], PROXY).code).toBe(2);
    expect(probe("network-probe.sh", ["setup", ALLOWED, OUT], [`|${ALLOWED}`]).code).toBe(2);
  });
});

describe("sibling probe", () => {
  const plant = () => {
    const sibling = join(dir, "projects", "other-app");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, ".env"), `SECRET=FACTORY-CANARY-${"0".repeat(32)}\n`);
    writeFileSync(join(dir, "control.txt"), "ok");
    return sibling;
  };

  test("a readable sibling .env is a leak, and the value is never printed", () => {
    const r = probe("sibling-probe.sh", [plant(), join(dir, "control.txt")], []);
    expect(r.code).toBe(1);
    expect(r.out).toContain("READABLE ");
    expect(r.out).not.toContain("0".repeat(32));
    // Readable is a leak by itself, whatever the file holds.
    const sibling = join(dir, "projects", "other-app");
    writeFileSync(join(sibling, ".env"), "SECRET=x\n");
    expect(probe("sibling-probe.sh", [sibling, join(dir, "control.txt")], [])).toEqual({ code: 1, out: `CONTROL-OK\nREADABLE ${sibling}/.env\nINDIRECT-HIDDEN\nRESULT LEAK\n` });
  });

  test("a missing .env proves nothing, so it is inconclusive", () => {
    const sibling = plant();
    rmSync(join(sibling, ".env"));
    expect(probe("sibling-probe.sh", [sibling, join(dir, "control.txt")], [])).toEqual({ code: 2, out: `CONTROL-OK\nUNKNOWN ${sibling}/.env\nINDIRECT-HIDDEN\nRESULT INCONCLUSIVE\n` });
  });

  test("a denied .env passes unless a search still finds the value; a failed control is inconclusive", () => {
    const sibling = plant();
    chmodSync(join(sibling, ".env"), 0o000);
    expect(probe("sibling-probe.sh", [sibling, join(dir, "control.txt")], [])).toEqual({ code: 0, out: `CONTROL-OK\nDENIED ${sibling}/.env\nINDIRECT-HIDDEN\nRESULT PASS\n` });
    writeFileSync(join(sibling, "copy.txt"), `FACTORY-CANARY-${"1".repeat(32)}`);
    const leak = probe("sibling-probe.sh", [sibling, join(dir, "control.txt")], []);
    expect(leak.code).toBe(1);
    expect(leak.out).toContain(`INDIRECT-LEAK ${sibling}/copy.txt`);
    rmSync(join(sibling, "copy.txt"));
    expect(probe("sibling-probe.sh", [sibling, join(dir, "missing.txt")], []).code).toBe(2);
    chmodSync(join(sibling, ".env"), 0o600);
  });
});
