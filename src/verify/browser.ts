/**
 * Evidence capture in Orca's embedded browser, in an isolated profile this module creates for one verification and
 * deletes afterwards. The profile is never named by a caller: `withVerificationProfile` owns its whole lifecycle, so
 * no capture can run in the owner's Default profile or in any other existing, possibly signed-in, profile.
 *
 * Each capture opens its own tab, so console and network entries belong to that one page load. Emulation is applied on
 * the blank tab before navigation, so the page initializes at the requested size, user agent, and touch support; Orca
 * resets emulation once the page has loaded, so it is applied again before the size is checked and the screenshot is
 * taken (spike 02, finding 15).
 *
 * Orca cannot restrict a page's requests to the preview origin (spike 02, Q52): `network route` can only abort by
 * pattern, with no way to allow one origin, and `intercept` only pauses. So this module does not pretend to: every
 * record says `browserEgress: "unrestricted"` and lists the other origins the page requested, and a capture whose
 * page left the preview origin fails.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord, str } from "../dispatch/jsonl";
import { OrcaError, orcaJson } from "../orca/cli";
import { assertRecordIds, clip, consoleErrors, type EvidenceRecord, externalOrigins, MAX_PAGE_TEXT_CHARS, networkFailures, type Viewport } from "./evidence";
import type { EvidenceStore } from "./store";

/**
 * Makes a capture repeatable: stops animations and transitions, hides the caret, waits for web fonts and two frames,
 * and reports the layout viewport so the caller can check the emulation took effect.
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
async function githubSession(orcaPath: string, page: string): Promise<GithubSessionCheck> {
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

export interface CaptureInput {
  /** An http(s) URL on the live preview; the capture is bound to its origin. */
  url: string;
  viewport: Viewport;
  /** Receives `<name>.png`. */
  store: EvidenceStore;
  name: string;
  acId: string | null;
  commitSha: string;
  /** Neutralize animations, carets, and font loading before the screenshot; on unless measuring nondeterminism. */
  stabilize?: boolean;
  /**
   * Called after the page loaded and again after the screenshot; a failure fails the capture. The driver passes the
   * preview's liveness check here, so the evidence is bound to the server that passed readiness.
   */
  serving?: () => { ok: true } | { ok: false; reason: string };
}

/** One verification's own browser profile. Its id never leaves this module. */
export interface VerificationBrowser {
  capture(input: CaptureInput): Promise<EvidenceRecord>;
  /** Opens a tab of this profile on `url` and reports its GitHub session, which must be signed out. */
  sessionAt(url: string): Promise<GithubSessionCheck & { title: string | null }>;
}

/** Thrown when the profile or a tab could not be verified gone; the ids are Orca's opaque handles, not secrets. */
export class BrowserCleanupError extends Error {
  constructor(message: string, readonly leaks: string[], cause?: unknown) {
    super(message, { cause });
  }
}

export interface ProfileOptions {
  orcaPath: string;
  /** Orca worktree selector the tabs open in, such as `path:<worktree>`. */
  worktree: string;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function originOf(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`verification URL must be http(s): ${url}`);
  return u.origin;
}

async function listTabs(orcaPath: string, profileId: string): Promise<string[]> {
  const r = await orcaJson(orcaPath, ["tab", "list"]);
  if (!Array.isArray(r.tabs)) throw new Error("orca tab list returned no tab list");
  return r.tabs.filter((t) => isRecord(t) && t.profileId === profileId && typeof t.browserPageId === "string").map((t) => (t as { browserPageId: string }).browserPageId);
}

async function listProfiles(orcaPath: string): Promise<{ id: string; label: string }[]> {
  const r = await orcaJson(orcaPath, ["tab", "profile", "list"]);
  if (!Array.isArray(r.profiles)) throw new Error("orca tab profile list returned no profile list");
  return r.profiles.filter((p) => isRecord(p) && typeof p.id === "string").map((p) => ({ id: (p as { id: string }).id, label: String((p as { label?: unknown }).label ?? "") }));
}

/**
 * Creates a fresh isolated profile, hands `use` a browser bound to it, and deletes the profile afterwards, with every
 * tab it opened. A creation or close whose outcome Orca left uncertain is reconciled against Orca's own tab and profile
 * lists, so nothing this verification created outlives it unnoticed: what cannot be verified gone is a
 * BrowserCleanupError naming it.
 */
export async function withVerificationProfile<T>(opts: ProfileOptions, use: (browser: VerificationBrowser) => Promise<T>): Promise<T> {
  const { orcaPath } = opts;
  const label = `factory-verify-${randomUUID()}`;
  let profileId: string;
  try {
    const r = await orcaJson(orcaPath, ["tab", "profile", "create", "--label", label, "--scope", "isolated"]);
    const p = isRecord(r.profile) ? r.profile : {};
    const id = str(p.id);
    if (!id) throw new OrcaError(`orca tab profile create returned no id: ${JSON.stringify(r).slice(0, 300)}`, true);
    profileId = id;
    if (p.scope !== "isolated" || p.source !== null) throw new Error(`orca created profile ${id} that is not empty and isolated: ${JSON.stringify(p).slice(0, 300)}`);
  } catch (err) {
    // Whatever was created under this verification's unique label is removed before the failure is reported.
    const leaks = await deleteByLabel(orcaPath, label);
    if (leaks.length > 0) throw new BrowserCleanupError(`profile creation failed (${(err as Error).message}) and left ${leaks.join(", ")}`, leaks, err);
    throw err;
  }

  const opened = new Set<string>();
  const leaks: string[] = [];

  const openTab = async (): Promise<string> => {
    // A create whose outcome is uncertain may have opened a tab after all; the end of the verification closes every tab
    // Orca lists for this profile, known or not.
    const page = str((await orcaJson(orcaPath, ["tab", "create", "--url", "about:blank", "--profile", profileId, "--worktree", opts.worktree])).browserPageId);
    if (!page) throw new Error("orca tab create returned no page id");
    opened.add(page);
    const shown = await orcaJson(orcaPath, ["tab", "profile", "show", "--page", page]);
    if (shown.profileId !== profileId) {
      await closeTab(page);
      throw new Error(`tab ${page} is bound to profile ${String(shown.profileId)}, not this verification's own`);
    }
    return page;
  };

  const closeTab = async (page: string): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await orcaJson(orcaPath, ["tab", "close", "--page", page]);
        opened.delete(page);
        return;
      } catch {
        try {
          if (!(await listTabs(orcaPath, profileId)).includes(page)) {
            opened.delete(page);
            return;
          }
        } catch {
          // unknown: try once more, then report
        }
      }
    }
    leaks.push(`tab ${page}`);
  };

  const withTab = async <R>(fn: (page: string) => Promise<R>): Promise<R> => {
    const page = await openTab();
    try {
      return await fn(page);
    } finally {
      await closeTab(page);
    }
  };

  /** Applies the viewport's emulation and checks Orca's answer matches it. */
  const emulate = async (page: string, v: Viewport): Promise<void> => {
    const r = v.device
      ? await orcaJson(orcaPath, ["set", "device", "--page", page, "--name", v.device])
      : await orcaJson(orcaPath, ["viewport", "--page", page, "--width", String(v.width), "--height", String(v.height), "--scale", String(v.scale), ...(v.mobile ? ["--mobile"] : [])]);
    if (r.width !== v.width || r.height !== v.height || r.deviceScaleFactor !== v.scale || r.mobile !== v.mobile) {
      throw new Error(`orca applied ${JSON.stringify(r).slice(0, 200)}, not the ${v.name} viewport ${v.width}x${v.height}@${v.scale}${v.mobile ? " mobile" : ""}`);
    }
  };

  const onOrigin = async (page: string, origin: string, when: string): Promise<string> => {
    const tab = await orcaJson(orcaPath, ["tab", "show", "--page", page]);
    const url = isRecord(tab.tab) ? str(tab.tab.url) : null;
    if (!url) throw new Error(`orca tab show gave no URL ${when}`);
    let at: string;
    try {
      at = new URL(url).origin;
    } catch {
      at = url;
    }
    if (at !== origin) throw new Error(`the page left the preview origin ${origin} ${when}: it is on ${at}`);
    return url;
  };

  const browser: VerificationBrowser = {
    async sessionAt(url) {
      originOf(url);
      return withTab(async (page) => {
        await orcaJson(orcaPath, ["goto", "--page", page, "--url", url]);
        const session = await githubSession(orcaPath, page);
        const tab = await orcaJson(orcaPath, ["tab", "show", "--page", page]);
        return { ...session, title: isRecord(tab.tab) ? str(tab.tab.title) : null };
      });
    },

    async capture(input) {
      assertRecordIds(input.acId, input.name);
      const origin = originOf(input.url);
      const v = input.viewport;
      const live = (when: string) => {
        const s = input.serving?.();
        if (s && !s.ok) throw new Error(`the preview stopped serving ${when}: ${s.reason}`);
      };
      return withTab(async (page) => {
        await orcaJson(orcaPath, ["console", "--page", page, "--limit", "1"]); // attaches capture before the load
        const session = await githubSession(orcaPath, page);
        if (session.signedIn) throw new Error("the verification profile holds a GitHub session; refusing to capture in it");
        await emulate(page, v); // before the load, so the page initializes at this size and user agent
        await orcaJson(orcaPath, ["goto", "--page", page, "--url", input.url]);
        await orcaJson(orcaPath, ["wait", "--page", page, "--load", "load"]);
        await emulate(page, v); // Orca resets emulation once the page has loaded
        await onOrigin(page, origin, "after it loaded");
        live("before the screenshot");
        let stabilized: StabilizeReport | null = null;
        if (input.stabilize !== false) {
          stabilized = parseStabilize((await orcaJson(orcaPath, ["eval", "--page", page, "--expression", STABILIZE_SCRIPT])).result);
          if (stabilized.width !== v.width || stabilized.height !== v.height) throw new Error(`viewport is ${stabilized.width}x${stabilized.height}, expected ${v.width}x${v.height}`);
          if (!stabilized.fonts) throw new Error("web fonts did not finish loading within 5s; the screenshot would not be repeatable");
        }
        const shot = await orcaJson(orcaPath, ["screenshot", "--page", page, "--format", "png"]);
        const shotPath = str(shot.path);
        if (!shotPath) throw new Error("orca screenshot returned no path");
        let stored;
        try {
          stored = input.store.putFile(`${input.name}.png`, shotPath);
        } finally {
          removeOrcaScreenshot(shotPath);
        }
        if (!isPng(stored.path)) throw new Error(`${stored.path} is not a PNG`);
        const finalUrl = await onOrigin(page, origin, "after the screenshot");
        live("after the screenshot");
        const con = await orcaJson(orcaPath, ["console", "--page", page, "--limit", "500"]);
        const net = await orcaJson(orcaPath, ["network", "--page", page, "--limit", "1000"]);
        const read = await orcaJson(orcaPath, ["exec", "--page", page, "--command", "read"]);
        const pageText = typeof read.content === "string" ? read.content : "";
        return {
          acId: input.acId,
          name: input.name,
          commitSha: input.commitSha,
          url: finalUrl,
          origin,
          browserEgress: "unrestricted",
          externalOrigins: externalOrigins(net.entries, origin),
          viewport: v,
          screenshotPath: stored.path,
          screenshotSha256: stored.sha256,
          screenshotBytes: stored.bytes,
          consoleErrors: consoleErrors(con.entries),
          networkFailures: networkFailures(net.entries),
          pageText: clip(pageText, MAX_PAGE_TEXT_CHARS),
          truncated: { console: con.truncated === true, network: net.truncated === true, pageText: read.truncated === true || pageText.length > MAX_PAGE_TEXT_CHARS },
          stabilized,
          capturedAt: new Date().toISOString(),
        };
      });
    },
  };

  let result: T;
  try {
    result = await use(browser);
  } catch (err) {
    await finish().catch(() => undefined);
    throw err;
  }
  await finish();
  return result;

  async function finish(): Promise<void> {
    try {
      for (const t of await listTabs(orcaPath, profileId)) await closeTab(t);
    } catch {
      for (const t of [...opened]) await closeTab(t);
    }
    leaks.push(...(await deleteByLabel(orcaPath, label)));
    if (leaks.length > 0) throw new BrowserCleanupError(`verification browser left ${leaks.join(", ")}`, [...leaks]);
  }

  /**
   * Deletes every profile Orca lists under this verification's unique label, and only those: an id from an answer
   * alone could name a profile that existed before, possibly the owner's. Returns what is still there or unverified.
   */
  async function deleteByLabel(orcaPath: string, label: string): Promise<string[]> {
    let ours: string[];
    try {
      ours = (await listProfiles(orcaPath)).filter((p) => p.label === label && p.id !== "default").map((p) => p.id);
    } catch {
      return [`profiles labelled ${label} (Orca's profile list was unavailable)`];
    }
    for (const id of ours) await orcaJson(orcaPath, ["tab", "profile", "delete", "--profile", id]).catch(() => undefined);
    try {
      return (await listProfiles(orcaPath)).filter((p) => p.label === label).map((p) => `profile ${p.id}`);
    } catch {
      return ours.map((id) => `profile ${id} (unverified)`);
    }
  }
}

function isPng(path: string): boolean {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const head = Buffer.alloc(8);
    return readSync(fd, head, 0, 8, 0) === 8 && head.equals(PNG_MAGIC);
  } finally {
    closeSync(fd);
  }
}

/** Removes the temp PNG Orca wrote for a screenshot, only from Orca's own screenshot directory. */
function removeOrcaScreenshot(path: string): void {
  try {
    const dir = join(realpathSync(tmpdir()), "orca-browser-screenshots");
    if (realpathSync(dirname(path)) !== dir || !/^[0-9a-f-]+-screenshot\.png$/.test(path.split("/").pop() ?? "")) return;
    if (!lstatSync(path).isFile()) return;
    unlinkSync(path);
  } catch {
    // Orca cleans its own directory too; a file left here is not evidence and holds nothing secret.
  }
}
