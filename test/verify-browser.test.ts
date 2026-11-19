import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserCleanupError, parseStabilize, withVerificationProfile } from "../src/verify/browser";
import { clip, consoleErrors, externalOrigins, MAX_ENTRY_CHARS, networkFailures, VIEWPORTS } from "../src/verify/evidence";
import { openEvidenceStore } from "../src/verify/store";

/**
 * A fake `orca` with state: profiles, tabs, and each tab's URL live in `state.json`, so tab and profile lists answer
 * like Orca's. Every call's argv goes to `calls.jsonl`. `responses.json` overrides answers by command key, and
 * `fail.json` makes a command fail: `clean` (ok:false), `uncertain` (garbage, exit 1), or `after` (takes effect, then
 * answers like `uncertain`), each `times` times (default always).
 */
let dir: string;
let orca: string;
let shots: string;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ORIGIN = "http://127.0.0.1:4100";

const FAKE = (d: string, shotDir: string) => `#!${process.execPath}
const fs = require("fs");
const dir = ${JSON.stringify(d)};
const args = process.argv.slice(2).filter((a) => a !== "--json");
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(args) + "\\n");
const read = (f, d) => (fs.existsSync(dir + "/" + f) ? JSON.parse(fs.readFileSync(dir + "/" + f, "utf8")) : d);
const st = read("state.json", { profiles: [{ id: "default", label: "Default", scope: "default" }], tabs: [], n: 0 });
const responses = read("responses.json", {});
const fails = read("fail.json", {});
const opt = (name) => { const i = args.indexOf("--" + name); return i < 0 ? null : args[i + 1]; };
const HANDLERS = {
  "tab profile create": () => { const p = { id: "prof-" + (++st.n), label: opt("label"), scope: "isolated", source: null }; st.profiles.push(p); return { profile: p }; },
  "tab profile list": () => ({ profiles: st.profiles }),
  "tab profile delete": () => { const id = opt("profile"); const had = st.profiles.some((p) => p.id === id); st.profiles = st.profiles.filter((p) => p.id !== id); st.tabs = st.tabs.filter((t) => t.profileId !== id); return { deleted: had }; },
  "tab profile show": () => ({ profileId: (st.tabs.find((t) => t.browserPageId === opt("page")) || {}).profileId ?? null }),
  "tab create": () => { const t = { browserPageId: "page-" + (++st.n), profileId: opt("profile"), url: opt("url"), title: "" }; st.tabs.push(t); return { browserPageId: t.browserPageId }; },
  "tab list": () => ({ tabs: st.tabs }),
  "tab close": () => { const had = st.tabs.some((t) => t.browserPageId === opt("page")); if (!had) throw new Error("no such tab"); st.tabs = st.tabs.filter((t) => t.browserPageId !== opt("page")); return { closed: true }; },
  "tab show": () => ({ tab: st.tabs.find((t) => t.browserPageId === opt("page")) }),
  "goto": () => { const t = st.tabs.find((t) => t.browserPageId === opt("page")); const redirects = read("redirects.json", {}); t.url = redirects[opt("url")] ?? opt("url"); t.title = "Page"; return {}; },
  "set device": () => ({ device: opt("name"), width: 390, height: 844, deviceScaleFactor: 3, mobile: true }),
  "viewport": () => ({ width: Number(opt("width")), height: Number(opt("height")), deviceScaleFactor: Number(opt("scale")), mobile: args.includes("--mobile") }),
  "screenshot": () => { const p = ${JSON.stringify(shotDir)} + "/" + crypto.randomUUID() + "-screenshot.png"; fs.copyFileSync(dir + "/shot.png", p); return { path: p }; },
  "console": () => ({ entries: [{ level: "log", text: "hello" }, { level: "error", text: "boom" }], truncated: false }),
  "network": () => ({ entries: [{ url: "${ORIGIN}/ok", method: "GET", status: 200 }, { url: "${ORIGIN}/missing?token=x", method: "GET", status: 404 }, { url: "https://cdn.example/a.js", method: "GET", status: 200 }, { url: "http://evil.example:8080/x", method: "POST" }], truncated: true }),
  "exec": () => ({ content: "# Title\\n\\nBody", truncated: false }),
  "wait": () => ({}),
  "eval": () => ({ result: JSON.stringify({ width: 1440, height: 900, fonts: true, frames: false, visibility: "visible" }) }),
  "cookie get": () => ({ cookies: [{ name: "logged_in", value: "no" }, { name: "_gh_sess", value: "s" }] }),
};
const key = [args.slice(0, 3).join(" "), args.slice(0, 2).join(" "), args[0]].find((k) => k in responses || k in fails || HANDLERS[k]);
const save = () => fs.writeFileSync(dir + "/state.json", JSON.stringify(st));
const f = fails[key];
if (f && (f.times ?? Infinity) > 0) {
  f.times = (f.times ?? Infinity) - 1; fs.writeFileSync(dir + "/fail.json", JSON.stringify(fails, (k, v) => (v === Infinity ? 1e9 : v)));
  if (f.mode === "clean") { console.log(JSON.stringify({ ok: false, error: { code: "browser_error" } })); process.exit(1); }
  if (f.mode === "after") { try { HANDLERS[key] && HANDLERS[key](); } catch {} save(); }
  console.log("garbage"); process.exit(1);
}
let result;
try { result = key in responses ? responses[key] : HANDLERS[key] ? HANDLERS[key]() : {}; } catch (e) { console.log(JSON.stringify({ ok: false, error: { message: e.message } })); process.exit(1); }
save();
console.log(JSON.stringify({ ok: true, result }));
`;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "verify-browser-")));
  shots = join(realpathSync(tmpdir()), "orca-browser-screenshots");
  mkdirSync(shots, { recursive: true, mode: 0o700 });
  orca = join(dir, "fake-orca");
  writeFileSync(orca, FAKE(dir, shots));
  chmodSync(orca, 0o755);
  writeFileSync(join(dir, "shot.png"), PNG);
  mkdirSync(join(dir, "state-root"), { mode: 0o700 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const calls = (): string[][] => (existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const state = () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { profiles: { id: string; label: string }[]; tabs: { browserPageId: string }[] };
const respond = (r: Record<string, unknown>) => writeFileSync(join(dir, "responses.json"), JSON.stringify(r));
const failing = (f: Record<string, { mode: "clean" | "uncertain" | "after"; times?: number }>) => writeFileSync(join(dir, "fail.json"), JSON.stringify(f));
const store = () => openEvidenceStore(join(dir, "state-root"), crypto.randomUUID());
const opts = () => ({ orcaPath: orca, worktree: "path:/wt" });
const capture = (extra: Partial<Parameters<Parameters<Parameters<typeof withVerificationProfile>[1]>[0]["capture"]>[0]> = {}) =>
  withVerificationProfile(opts(), (b) => b.capture({ url: `${ORIGIN}/?error=1`, viewport: VIEWPORTS.desktop, store: store(), name: "before-desktop", acId: "AC-1", commitSha: "a".repeat(40), ...extra }));
const onlyDefault = () => expect(state().profiles.map((p) => p.id)).toEqual(["default"]);

describe("withVerificationProfile", () => {
  test("one owned lifecycle: a fresh labelled isolated profile, tabs only in it, and both gone afterwards", async () => {
    const r = await capture();
    const c = calls().map((x) => x.join(" "));
    const created = c.find((x) => x.startsWith("tab profile create"))!;
    expect(created).toMatch(/^tab profile create --label factory-verify-[0-9a-f-]{36} --scope isolated$/);
    expect(c.filter((x) => x.startsWith("tab create"))).toEqual(["tab create --url about:blank --profile prof-1 --worktree path:/wt"]);
    expect(c.at(-1)).toBe("tab profile list"); // verified gone
    onlyDefault();
    expect(state().tabs).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("prof-1"); // the profile id stays inside the module
  });

  test("a created profile that is not empty and isolated is deleted and refused", async () => {
    respond({ "tab profile create": { profile: { id: "imported", scope: "imported", source: { browserFamily: "chromium" } } } });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ profiles: [{ id: "default", label: "Default" }], tabs: [], n: 0 }));
    // The answer is canned, so the profile it names is planted under the verification's label by the list below.
    let used = false;
    await expect(withVerificationProfile(opts(), async () => (used = true))).rejects.toThrow("not empty and isolated");
    expect(used).toBe(false);
    expect(calls().some((x) => x.join(" ") === "tab profile delete --profile imported")).toBe(false); // not ours by label
  });

  test("a profile creation whose outcome is uncertain is reconciled by label: what it created is deleted", async () => {
    failing({ "tab profile create": { mode: "after" } });
    await expect(withVerificationProfile(opts(), async () => 1)).rejects.toThrow();
    expect(calls().some((x) => x.join(" ") === "tab profile delete --profile prof-1")).toBe(true);
    onlyDefault();
  });

  test("a tab creation whose outcome is uncertain closes the tab it may have opened", async () => {
    failing({ "tab create": { mode: "after", times: 1 } });
    await expect(capture()).rejects.toThrow();
    expect(calls().filter((x) => x[0] === "tab" && x[1] === "close").length).toBeGreaterThanOrEqual(1);
    expect(state().tabs).toEqual([]);
    onlyDefault();
  });

  test("a tab close that fails once is retried; one that cannot be verified is a cleanup error naming it", async () => {
    failing({ "tab close": { mode: "clean", times: 1 } });
    await capture();
    expect(state().tabs).toEqual([]);
    failing({ "tab close": { mode: "clean" }, "tab profile delete": { mode: "clean" } });
    const err = await capture().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserCleanupError);
    expect((err as BrowserCleanupError).leaks.join(" ")).toMatch(/tab page-\d+.*profile prof-\d+/);
  });

  test("profiles that existed before, such as the owner's, are never deleted or used, whatever fails", async () => {
    const owner = { profiles: [{ id: "default", label: "Default" }, { id: "work", label: "Work", scope: "isolated", source: null }], tabs: [], n: 0 };
    writeFileSync(join(dir, "state.json"), JSON.stringify(owner));
    await capture();
    failing({ "tab profile create": { mode: "after" } });
    await expect(capture()).rejects.toThrow();
    failing({ "tab close": { mode: "clean" } });
    await expect(capture()).rejects.toThrow();
    expect(state().profiles.map((p) => p.id).filter((id) => !id.startsWith("prof-"))).toEqual(["default", "work"]);
    expect(calls().filter((x) => x.join(" ").includes("--profile work") || x.join(" ").includes("--profile default"))).toEqual([]);
  });

  test("a tab Orca bound to another profile is closed before anything loads", async () => {
    respond({ "tab profile show": { profileId: "default" } });
    await expect(capture()).rejects.toThrow("bound to profile default");
    expect(calls().some((x) => x[0] === "goto")).toBe(false);
    expect(state().tabs).toEqual([]);
  });

  test("the profile is deleted even when the caller's work throws, and the caller's error wins", async () => {
    await expect(withVerificationProfile(opts(), async () => { throw new Error("capture broke"); })).rejects.toThrow("capture broke");
    onlyDefault();
  });
});

describe("capture", () => {
  test("order: blank tab, capture attached, session checked, emulation, load, emulation again, origin, screenshot, origin", async () => {
    await capture();
    const page = calls().map((x) => x.join(" ")).filter((x) => x.includes("--page page-2")).map((x) => x.split(" --page")[0]);
    expect(page).toEqual(["tab profile show", "console", "cookie get", "viewport", "goto", "wait", "viewport", "tab show", "eval", "screenshot", "tab show", "console", "network", "exec", "tab close"]);
  });

  test("records the bound origin, unrestricted browser egress, the other origins requested, and a stored screenshot", async () => {
    const s = store();
    const r = await withVerificationProfile(opts(), (b) => b.capture({ url: `${ORIGIN}/?error=1`, viewport: VIEWPORTS.desktop, store: s, name: "before-desktop", acId: "AC-1", commitSha: "a".repeat(40) }));
    expect(r).toMatchObject({
      acId: "AC-1",
      origin: ORIGIN,
      url: `${ORIGIN}/?error=1`,
      browserEgress: "unrestricted",
      externalOrigins: ["http://evil.example:8080", "https://cdn.example"],
      consoleErrors: ["boom"],
      pageText: "# Title\n\nBody",
      truncated: { console: false, network: true, pageText: false },
      viewport: VIEWPORTS.desktop,
      screenshotBytes: PNG.length,
    });
    expect(r.screenshotPath).toBe(join(s.dir, "before-desktop.png"));
    expect(readFileSync(r.screenshotPath)).toEqual(PNG);
    expect(r.screenshotSha256).toBe(new Bun.CryptoHasher("sha256").update(PNG).digest("hex"));
    const shot = calls().find((x) => x[0] === "screenshot");
    expect(shot).toBeDefined();
  });

  test("Orca's temp screenshot is removed once it is in the store", async () => {
    const before = new Set(require("node:fs").readdirSync(shots));
    await capture();
    expect(require("node:fs").readdirSync(shots).filter((n: string) => !before.has(n))).toEqual([]);
  });

  test("mobile sets the device preset, with its user agent, on the blank tab before the load and again after it", async () => {
    respond({ eval: { result: JSON.stringify({ width: 390, height: 844, fonts: true, frames: true, visibility: "visible" }) } });
    await capture({ viewport: VIEWPORTS.mobile, name: "m" });
    const page = calls().map((x) => x.join(" ")).filter((x) => x.includes("--page page-2"));
    const device = page.filter((x) => x.startsWith("set device"));
    expect(device).toEqual(["set device --page page-2 --name iPhone 12", "set device --page page-2 --name iPhone 12"]);
    expect(page.findIndex((x) => x.startsWith("set device"))).toBeLessThan(page.findIndex((x) => x.startsWith("goto")));
    expect(page.findLastIndex((x) => x.startsWith("set device"))).toBeGreaterThan(page.findIndex((x) => x.startsWith("wait")));
  });

  test("emulation Orca did not apply as asked, or a size that did not take effect, fails the capture", async () => {
    respond({ "set device": { width: 375, height: 667, deviceScaleFactor: 2, mobile: true } });
    await expect(capture({ viewport: VIEWPORTS.mobile, name: "m" })).rejects.toThrow("not the mobile viewport 390x844@3 mobile");
    respond({});
    await expect(capture({ viewport: VIEWPORTS.mobile, name: "m" })).rejects.toThrow("viewport is 1440x900, expected 390x844");
    onlyDefault();
  });

  test("a page that left the preview origin fails the capture", async () => {
    writeFileSync(join(dir, "redirects.json"), JSON.stringify({ [`${ORIGIN}/?error=1`]: "https://github.com/login" }));
    await expect(capture()).rejects.toThrow(`left the preview origin ${ORIGIN} after it loaded: it is on https://github.com`);
    expect(calls().some((x) => x[0] === "screenshot")).toBe(false);
  });

  test("a signed-in verification profile is refused before anything loads", async () => {
    respond({ "cookie get": { cookies: [{ name: "user_session", value: "SECRET" }, { name: "logged_in", value: "yes" }] } });
    await expect(capture()).rejects.toThrow("holds a GitHub session");
    expect(calls().some((x) => x[0] === "goto")).toBe(false);
  });

  test("the capture is bound to the live preview: a server that stopped serving before or after the screenshot fails it", async () => {
    let n = 0;
    await expect(capture({ serving: () => (++n === 1 ? { ok: false, reason: "nothing listens" } : { ok: true }) })).rejects.toThrow("stopped serving before the screenshot: nothing listens");
    n = 0;
    await expect(capture({ name: "late", serving: () => (++n === 2 ? { ok: false, reason: "a stranger listens" } : { ok: true }) })).rejects.toThrow("stopped serving after the screenshot");
  });

  test("fonts that never finish loading, a non-PNG screenshot, and unsafe ids fail the capture", async () => {
    respond({ eval: { result: JSON.stringify({ width: 1440, height: 900, fonts: false, frames: true, visibility: "visible" }) } });
    await expect(capture()).rejects.toThrow("web fonts");
    respond({});
    writeFileSync(join(dir, "shot.png"), "not a png");
    await expect(capture()).rejects.toThrow("not a PNG");
    await expect(capture({ name: "../x" })).rejects.toThrow("evidence name");
    await expect(capture({ acId: "AC-1 @owner" })).rejects.toThrow("AC-1");
    await expect(capture({ url: "file:///etc/passwd" })).rejects.toThrow("http(s)");
  });

  test("sessionAt reports the profile's GitHub cookie names and logged_in only", async () => {
    const s = await withVerificationProfile(opts(), (b) => b.sessionAt("https://github.com/o/r/pull/1"));
    expect(s).toEqual({ cookieNames: ["_gh_sess", "logged_in"], loggedIn: "no", signedIn: false, title: "Page" });
    respond({ "cookie get": { cookies: [{ name: "user_session", value: "SECRET" }] } });
    const t = await withVerificationProfile(opts(), (b) => b.sessionAt("https://github.com/o/r/pull/1"));
    expect(t.signedIn).toBe(true);
    expect(JSON.stringify(t)).not.toContain("SECRET");
  });
});

describe("parsers", () => {
  test("consoleErrors keeps level error only, bounded; networkFailures keeps 4xx, 5xx, and no-response", () => {
    expect(consoleErrors([{ level: "warning", text: "w" }, { level: "error", text: "e" }, null])).toEqual(["e"]);
    expect(consoleErrors(Array.from({ length: 300 }, () => ({ level: "error", text: "word ".repeat(1000) }))).map((e) => e.length)).toEqual(Array(200).fill(1999));
    expect(networkFailures([{ url: "a", status: 200 }, { url: "b", status: 304 }, { url: "c", status: 500, method: "PUT" }, { url: "d", status: 0 }, { status: 404 }])).toEqual([
      { url: "c", method: "PUT", status: 500 },
      { url: "d", method: "GET", status: null },
    ]);
    expect(externalOrigins([{ url: `${ORIGIN}/a` }, { url: "https://x.example/b?q=1" }, { url: "https://x.example/c" }, { url: "not a url" }, { url: "data:," }], ORIGIN)).toEqual(["https://x.example"]);
    expect(() => consoleErrors({})).toThrow();
  });

  test("text is cut only at a break, so a path is never split where redaction cannot recognize it", () => {
    const home = homedir();
    const line = `${"a ".repeat(990)}${home}/.codex/AGENTS.md is denied`;
    expect(line.indexOf(home)).toBeLessThan(MAX_ENTRY_CHARS);
    expect(line.indexOf(home) + home.length).toBeGreaterThan(MAX_ENTRY_CHARS - 20);
    const [kept] = consoleErrors([{ level: "error", text: `${line}${" b".repeat(1000)}` }]);
    expect(kept).toBe("a ".repeat(990).trimEnd());
    expect(clip("x".repeat(50), 10)).toBe("[factory: 50 characters without a break, omitted]");
    expect(clip("short", 10)).toBe("short");
    expect(clip("one two\nthree", 9)).toBe("one two");
  });

  test("parseStabilize refuses anything but the script's own report", () => {
    expect(() => parseStabilize("[1440,900]")).toThrow("stabilize script returned");
    expect(() => parseStabilize(undefined)).toThrow();
    expect(parseStabilize(JSON.stringify({ width: 1, height: 2, fonts: true, frames: false, visibility: "visible" })).height).toBe(2);
  });
});
