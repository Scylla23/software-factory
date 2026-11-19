/**
 * Evidence capture in Orca's embedded browser, always in a fresh isolated profile the factory creates for one
 * verification and deletes afterwards, never in the owner's signed-in Default profile.
 *
 * Each capture opens its own tab, so console and network entries belong to that one page load. Orca resets the
 * viewport on every navigation, so the page loads at the pane's size and is then resized to the fixed viewport;
 * CSS media queries follow the resize, script that measured the window at load does not (spike 02).
 */
import { constants, copyFileSync, createReadStream, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isRecord, str } from "../dispatch/jsonl";
import { orcaJson } from "../orca/cli";
import { assertRecordIds, consoleErrors, type EvidenceRecord, networkFailures, type Viewport } from "./evidence";

const PROFILE_LABEL = /^factory-verify-[a-z0-9-]{1,64}$/;

/** Creates an empty isolated profile; its partition starts with no cookies or storage. */
export async function createVerificationProfile(orcaPath: string, label: string): Promise<string> {
  if (!PROFILE_LABEL.test(label)) throw new Error(`profile label must match ${PROFILE_LABEL}: ${label}`);
  const r = await orcaJson(orcaPath, ["tab", "profile", "create", "--label", label, "--scope", "isolated"]);
  const p = isRecord(r.profile) ? r.profile : {};
  const id = str(p.id);
  if (!id || p.scope !== "isolated" || p.source !== null) throw new Error(`orca created no empty isolated profile: ${JSON.stringify(r).slice(0, 300)}`);
  return id;
}

export async function deleteVerificationProfile(orcaPath: string, profileId: string): Promise<void> {
  if (profileId === "default") throw new Error("refusing to delete the Default profile");
  const r = await orcaJson(orcaPath, ["tab", "profile", "delete", "--profile", profileId]);
  if (r.deleted !== true) throw new Error(`orca did not delete profile ${profileId}`);
}

export interface TabTarget {
  orcaPath: string;
  /** Orca worktree selector the tab opens in, such as `path:<worktree>`. */
  worktree: string;
  profileId: string;
}

/**
 * Opens `url` in a new tab of the verification profile and runs `use` on it, closing the tab whatever happens.
 * The tab starts on about:blank: Orca attaches console and network capture to a page on its first command, so a tab
 * created on the URL itself would miss everything its first load logged (spike 02). Before anything loads, the tab's
 * profile is checked against the one the factory created, so a capture can never run in the owner's profile.
 */
export async function withVerificationTab<T>(target: TabTarget, url: string, use: (page: string) => Promise<T>): Promise<T> {
  if (target.profileId === "default") throw new Error("verification never runs in the Default profile");
  if (!/^https?:\/\//.test(url)) throw new Error(`verification URL must be http(s): ${url}`);
  const created = await orcaJson(target.orcaPath, ["tab", "create", "--url", "about:blank", "--profile", target.profileId, "--worktree", target.worktree]);
  const page = str(created.browserPageId);
  if (!page) throw new Error(`orca tab create returned no page id: ${JSON.stringify(created).slice(0, 300)}`);
  let result: T;
  try {
    const shown = await orcaJson(target.orcaPath, ["tab", "profile", "show", "--page", page]);
    if (shown.profileId !== target.profileId) throw new Error(`tab ${page} is bound to profile ${String(shown.profileId)}, not ${target.profileId}`);
    await orcaJson(target.orcaPath, ["console", "--page", page, "--limit", "1"]); // attaches capture before the load
    await orcaJson(target.orcaPath, ["goto", "--page", page, "--url", url]);
    result = await use(page);
  } catch (err) {
    // The tab still closes; a close failure here must not hide why the capture failed.
    await orcaJson(target.orcaPath, ["tab", "close", "--page", page]).catch(() => undefined);
    throw err;
  }
  await orcaJson(target.orcaPath, ["tab", "close", "--page", page]);
  return result;
}

/**
 * Makes a capture repeatable: stops animations and transitions, hides the caret, waits for web fonts and two frames,
 * and reports the layout viewport so the caller can check the resize took effect.
 * Every wait is bounded: a tab Orca is not showing gets no animation frames, which hung an unbounded wait (spike 02).
 */
export const STABILIZE_SCRIPT = `(async () => {
  const bounded = (p, ms) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }";
  document.documentElement.appendChild(style);
  for (const a of document.getAnimations()) a.finish();
  const fonts = await bounded(document.fonts.ready, 5000);
  const frames = await bounded(new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), 500);
  return JSON.stringify({ width: innerWidth, height: innerHeight, fonts, frames, visibility: document.visibilityState });
})()`;

/** What the stabilize script saw; `fonts` or `frames` false means that wait timed out. */
export interface StabilizeReport {
  width: number;
  height: number;
  fonts: boolean;
  frames: boolean;
  visibility: string;
}

export function parseStabilize(raw: unknown): StabilizeReport {
  let v: unknown;
  try {
    v = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    v = null;
  }
  if (!isRecord(v) || typeof v.width !== "number" || typeof v.height !== "number" || typeof v.fonts !== "boolean" || typeof v.frames !== "boolean" || typeof v.visibility !== "string") {
    throw new Error(`stabilize script returned ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  return { width: v.width, height: v.height, fonts: v.fonts, frames: v.frames, visibility: v.visibility };
}

export interface CaptureInput {
  target: TabTarget;
  url: string;
  viewport: Viewport;
  /** Existing private dir that receives `<name>.png`. */
  outDir: string;
  name: string;
  acId: string | null;
  commitSha: string;
  /** Neutralize animations, carets, and font loading before the screenshot; on unless measuring nondeterminism. */
  stabilize?: boolean;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function captureEvidence(input: CaptureInput): Promise<EvidenceRecord> {
  assertRecordIds(input.acId, input.name);
  const { orcaPath } = input.target;
  const v = input.viewport;
  return withVerificationTab(input.target, input.url, async (page) => {
    await orcaJson(orcaPath, ["wait", "--page", page, "--load", "load"]);
    await orcaJson(orcaPath, ["viewport", "--page", page, "--width", String(v.width), "--height", String(v.height), "--scale", String(v.scale), ...(v.mobile ? ["--mobile"] : [])]);
    let stabilized: StabilizeReport | null = null;
    if (input.stabilize !== false) {
      stabilized = parseStabilize((await orcaJson(orcaPath, ["eval", "--page", page, "--expression", STABILIZE_SCRIPT])).result);
      if (stabilized.width !== v.width || stabilized.height !== v.height) throw new Error(`viewport is ${stabilized.width}x${stabilized.height}, expected ${v.width}x${v.height}`);
      if (!stabilized.fonts) throw new Error("web fonts did not finish loading within 5s; the screenshot would not be repeatable");
    }
    const shot = await orcaJson(orcaPath, ["screenshot", "--page", page, "--format", "png"]);
    const shotPath = str(shot.path);
    if (!shotPath) throw new Error("orca screenshot returned no path");
    const dest = join(input.outDir, `${input.name}.png`);
    copyFileSync(shotPath, dest, constants.COPYFILE_EXCL);
    if (!readFileSync(dest).subarray(0, 8).equals(PNG_MAGIC)) throw new Error(`${dest} is not a PNG`);
    const con = await orcaJson(orcaPath, ["console", "--page", page, "--limit", "500"]);
    const net = await orcaJson(orcaPath, ["network", "--page", page, "--limit", "1000"]);
    const read = await orcaJson(orcaPath, ["exec", "--page", page, "--command", "read"]);
    const tab = await orcaJson(orcaPath, ["tab", "show", "--page", page]);
    const finalUrl = isRecord(tab.tab) ? str(tab.tab.url) : null;
    return {
      acId: input.acId,
      name: input.name,
      commitSha: input.commitSha,
      url: finalUrl ?? input.url,
      viewport: v,
      screenshotPath: dest,
      screenshotSha256: await sha256File(dest),
      consoleErrors: consoleErrors(con.entries),
      networkFailures: networkFailures(net.entries),
      pageText: typeof read.content === "string" ? read.content : "",
      truncated: { console: con.truncated === true, network: net.truncated === true, pageText: read.truncated === true },
      profileId: input.target.profileId,
      stabilized,
      capturedAt: new Date().toISOString(),
    };
  });
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/** GitHub's session cookies: any of these in a profile means it is signed in to GitHub. */
const GITHUB_SESSION_COOKIES = new Set(["user_session", "__Host-user_session_same_site", "dotcom_user"]);

export interface GithubSessionCheck {
  /** Cookie names only; values never leave Orca's answer. */
  cookieNames: string[];
  /** The `logged_in` cookie's value (`yes` or `no`), which is not a secret. */
  loggedIn: string | null;
  signedIn: boolean;
}

/** Reads, from the page's own profile, which GitHub cookies it holds, without reporting any value but `logged_in`. */
export async function githubSession(orcaPath: string, page: string): Promise<GithubSessionCheck> {
  const r = await orcaJson(orcaPath, ["cookie", "get", "--page", page, "--url", "https://github.com"]);
  if (!Array.isArray(r.cookies)) throw new Error("orca cookie get returned no cookie list");
  const names: string[] = [];
  let loggedIn: string | null = null;
  for (const c of r.cookies) {
    if (!isRecord(c) || typeof c.name !== "string") continue;
    names.push(c.name);
    if (c.name === "logged_in" && typeof c.value === "string") loggedIn = c.value;
  }
  return { cookieNames: names.sort(), loggedIn, signedIn: loggedIn === "yes" || names.some((n) => GITHUB_SESSION_COOKIES.has(n)) };
}
