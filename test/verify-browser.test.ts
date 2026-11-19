import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEvidence, createVerificationProfile, deleteVerificationProfile, githubSession, parseStabilize, withVerificationTab } from "../src/verify/browser";
import { consoleErrors, networkFailures, VIEWPORTS } from "../src/verify/evidence";

/**
 * A fake `orca`: answers each command from `responses.json` (keyed by the first two or three words), records every
 * call's argv to `calls.jsonl`, and fails a command listed in `fail.json`.
 */
let dir: string;
let orca: string;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PROFILE = "11111111-2222-3333-4444-555555555555";

function setResponses(overrides: Record<string, unknown> = {}) {
  const shot = join(dir, "orca-shot.png");
  writeFileSync(shot, PNG);
  const base: Record<string, unknown> = {
    "tab create": { browserPageId: "page-1" },
    "tab profile show": { profileId: PROFILE },
    "tab profile create": { profile: { id: PROFILE, scope: "isolated", source: null } },
    "tab profile delete": { deleted: true },
    "tab close": { closed: true },
    "tab show": { tab: { url: "http://127.0.0.1:4100/?error=1" } },
    "console": { entries: [{ level: "log", text: "hello" }, { level: "error", text: "boom" }], truncated: false },
    "network": { entries: [{ url: "http://x/ok", method: "GET", status: 200 }, { url: "http://x/missing", method: "GET", status: 404 }, { url: "http://x/refused", method: "POST" }], truncated: true },
    "exec": { content: "# Title\n\nBody", truncated: false },
    "screenshot": { path: shot },
    "eval": { result: JSON.stringify({ width: 1440, height: 900, fonts: true, frames: false, visibility: "visible" }) },
    "cookie get": { cookies: [{ name: "logged_in", value: "no" }, { name: "_gh_sess", value: "s" }] },
  };
  writeFileSync(join(dir, "responses.json"), JSON.stringify({ ...base, ...overrides }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-browser-"));
  orca = join(dir, "fake-orca");
  writeFileSync(
    orca,
    `#!${process.execPath}
const fs = require("fs");
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(args) + "\\n");
const responses = JSON.parse(fs.readFileSync(dir + "/responses.json", "utf8"));
const fail = fs.existsSync(dir + "/fail.json") ? JSON.parse(fs.readFileSync(dir + "/fail.json", "utf8")) : [];
const key = [args.slice(0, 3).join(" "), args.slice(0, 2).join(" "), args[0]].find((k) => k in responses || fail.includes(k));
if (fail.includes(key)) { console.log(JSON.stringify({ ok: false, error: { code: "browser_error" } })); process.exit(1); }
console.log(JSON.stringify({ ok: true, result: key ? responses[key] : {} }));
`,
  );
  chmodSync(orca, 0o755);
  setResponses();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const calls = (): string[][] => readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const target = () => ({ orcaPath: orca, worktree: "path:/wt", profileId: PROFILE });

describe("withVerificationTab", () => {
  test("opens about:blank in the verification profile, checks the binding, attaches capture, then loads, then closes", async () => {
    const seen = await withVerificationTab(target(), "http://127.0.0.1:4100/", async (page) => page);
    expect(seen).toBe("page-1");
    expect(calls().map((c) => c.slice(0, -1).join(" "))).toEqual([
      `tab create --url about:blank --profile ${PROFILE} --worktree path:/wt`,
      "tab profile show --page page-1",
      "console --page page-1 --limit 1",
      "goto --page page-1 --url http://127.0.0.1:4100/",
      "tab close --page page-1",
    ]);
  });

  test("refuses a tab Orca bound to another profile before loading anything, and still closes it", async () => {
    setResponses({ "tab profile show": { profileId: "default" } });
    let used = false;
    await expect(withVerificationTab(target(), "http://127.0.0.1:4100/", async () => (used = true))).rejects.toThrow("bound to profile default");
    expect(used).toBe(false);
    expect(calls().some((x) => x[0] === "goto")).toBe(false);
    expect(calls().at(-1)!.slice(0, 2)).toEqual(["tab", "close"]);
  });

  test("never runs in the Default profile and only loads http(s)", async () => {
    await expect(withVerificationTab({ ...target(), profileId: "default" }, "http://x/", async () => 1)).rejects.toThrow("Default profile");
    await expect(withVerificationTab(target(), "file:///etc/passwd", async () => 1)).rejects.toThrow("http(s)");
    expect(existsSync(join(dir, "calls.jsonl"))).toBe(false);
  });

  test("a failing capture closes the tab and reports the capture's error, not the close's", async () => {
    writeFileSync(join(dir, "fail.json"), JSON.stringify(["tab close"]));
    await expect(withVerificationTab(target(), "http://x/", async () => { throw new Error("capture broke"); })).rejects.toThrow("capture broke");
    expect(calls().at(-1)!.slice(0, 2)).toEqual(["tab", "close"]);
  });
});

describe("captureEvidence", () => {
  test("records console errors, failed requests, page text, viewport, and a copied screenshot", async () => {
    const r = await captureEvidence({ target: target(), url: "http://127.0.0.1:4100/?error=1", viewport: VIEWPORTS.desktop, outDir: dir, name: "before-desktop", acId: "AC-1", commitSha: "a".repeat(40) });
    expect(r).toMatchObject({
      acId: "AC-1",
      consoleErrors: ["boom"],
      networkFailures: [{ url: "http://x/missing", method: "GET", status: 404 }, { url: "http://x/refused", method: "POST", status: null }],
      pageText: "# Title\n\nBody",
      truncated: { console: false, network: true, pageText: false },
      profileId: PROFILE,
      viewport: VIEWPORTS.desktop,
    });
    expect(r.screenshotPath).toBe(join(dir, "before-desktop.png"));
    expect(readFileSync(r.screenshotPath)).toEqual(PNG);
    expect(r.screenshotSha256).toBe(new Bun.CryptoHasher("sha256").update(PNG).digest("hex"));
    const vp = calls().find((c) => c[0] === "viewport")!;
    expect(vp.slice(0, -1)).toEqual(["viewport", "--page", "page-1", "--width", "1440", "--height", "900", "--scale", "1"]);
  });

  test("mobile gets touch emulation; a viewport that did not take effect fails the capture", async () => {
    await expect(captureEvidence({ target: target(), url: "http://x/", viewport: VIEWPORTS.mobile, outDir: dir, name: "m", acId: null, commitSha: "a".repeat(40) })).rejects.toThrow("viewport is 1440x900, expected 390x844");
    expect(calls().find((c) => c[0] === "viewport")).toContain("--mobile");
    expect(calls().at(-1)!.slice(0, 2)).toEqual(["tab", "close"]);
  });

  test("fonts that never finish loading fail the capture instead of producing an unrepeatable screenshot", async () => {
    setResponses({ eval: { result: JSON.stringify({ width: 1440, height: 900, fonts: false, frames: true, visibility: "visible" }) } });
    await expect(captureEvidence({ target: target(), url: "http://x/", viewport: VIEWPORTS.desktop, outDir: dir, name: "f", acId: null, commitSha: "a".repeat(40) })).rejects.toThrow("web fonts");
  });

  test("refuses to overwrite an existing screenshot and a non-PNG answer", async () => {
    writeFileSync(join(dir, "dup.png"), "x");
    await expect(captureEvidence({ target: target(), url: "http://x/", viewport: VIEWPORTS.desktop, outDir: dir, name: "dup", acId: null, commitSha: "a".repeat(40) })).rejects.toThrow();
    writeFileSync(join(dir, "orca-shot.png"), "not a png");
    await expect(captureEvidence({ target: target(), url: "http://x/", viewport: VIEWPORTS.desktop, outDir: dir, name: "np", acId: null, commitSha: "a".repeat(40) })).rejects.toThrow("not a PNG");
  });

  test("refuses ids that would not be safe in a path or a comment", async () => {
    const base = { target: target(), url: "http://x/", viewport: VIEWPORTS.desktop, outDir: dir, commitSha: "a".repeat(40) };
    await expect(captureEvidence({ ...base, name: "../x", acId: null })).rejects.toThrow("evidence name");
    await expect(captureEvidence({ ...base, name: "x", acId: "AC-1 @owner" })).rejects.toThrow("AC-1");
  });
});

describe("profiles and sessions", () => {
  test("creates only an empty isolated profile and never deletes Default", async () => {
    expect(await createVerificationProfile(orca, "factory-verify-abc")).toBe(PROFILE);
    await expect(createVerificationProfile(orca, "Default")).rejects.toThrow("profile label");
    setResponses({ "tab profile create": { profile: { id: "x", scope: "imported", source: { browserFamily: "chromium" } } } });
    await expect(createVerificationProfile(orca, "factory-verify-abc")).rejects.toThrow("no empty isolated profile");
    await expect(deleteVerificationProfile(orca, "default")).rejects.toThrow("Default");
  });

  test("githubSession reports names and logged_in only, and flags any session cookie", async () => {
    expect(await githubSession(orca, "page-1")).toEqual({ cookieNames: ["_gh_sess", "logged_in"], loggedIn: "no", signedIn: false });
    setResponses({ "cookie get": { cookies: [{ name: "user_session", value: "SECRET" }, { name: "logged_in", value: "yes" }] } });
    const s = await githubSession(orca, "page-1");
    expect(s.signedIn).toBe(true);
    expect(JSON.stringify(s)).not.toContain("SECRET");
    setResponses({ "cookie get": { cookies: [{ name: "__Host-user_session_same_site", value: "S" }] } });
    expect((await githubSession(orca, "page-1")).signedIn).toBe(true);
  });
});

describe("parsers", () => {
  test("consoleErrors keeps level error only; networkFailures keeps 4xx, 5xx, and no-response", () => {
    expect(consoleErrors([{ level: "warning", text: "w" }, { level: "error", text: "e" }, null])).toEqual(["e"]);
    expect(networkFailures([{ url: "a", status: 200 }, { url: "b", status: 304 }, { url: "c", status: 500, method: "PUT" }, { url: "d", status: 0 }, { status: 404 }])).toEqual([
      { url: "c", method: "PUT", status: 500 },
      { url: "d", method: "GET", status: null },
    ]);
    expect(() => consoleErrors({})).toThrow();
  });

  test("parseStabilize refuses anything but the script's own report", () => {
    expect(() => parseStabilize("[1440,900]")).toThrow("stabilize script returned");
    expect(() => parseStabilize(undefined)).toThrow();
    expect(parseStabilize(JSON.stringify({ width: 1, height: 2, fonts: true, frames: false, visibility: "visible" })).height).toBe(2);
  });
});
