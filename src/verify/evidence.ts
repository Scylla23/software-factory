import { isRecord } from "../dispatch/jsonl";

export interface Viewport {
  name: "desktop" | "mobile";
  width: number;
  height: number;
  /** Device scale factor; screenshots are in CSS pixels either way. */
  scale: number;
  /** Touch input and `pointer: coarse`. */
  mobile: boolean;
  /**
   * Orca's device preset, which also sets the device's user agent; its size must equal the viewport's. Without one the
   * page gets a desktop user agent.
   */
  device: string | null;
}

/** The fixed viewports every UI criterion is captured at. */
export const VIEWPORTS: Readonly<Record<Viewport["name"], Viewport>> = {
  desktop: { name: "desktop", width: 1440, height: 900, scale: 1, mobile: false, device: null },
  mobile: { name: "mobile", width: 390, height: 844, scale: 3, mobile: true, device: "iPhone 12" },
};

/** Bounds on what one record keeps of page-derived text; Orca's own limits apply first. */
export const MAX_CONSOLE_ERRORS = 200;
export const MAX_ENTRY_CHARS = 2_000;
export const MAX_PAGE_TEXT_CHARS = 256 * 1024;

export interface NetworkFailure {
  url: string;
  method: string;
  /** HTTP status, or null when the request never got a response. */
  status: number | null;
}

/** One capture of one page at one viewport on one commit. Page-derived strings are untrusted data. */
export interface EvidenceRecord {
  /** The acceptance criterion this proves, such as `AC-1`; null until plan step 5 binds criteria. */
  acId: string | null;
  /** Unique within a set of records, `[a-z0-9-]`; names the screenshot file. */
  name: string;
  commitSha: string;
  /** The page URL that was captured. */
  url: string;
  /** The preview origin the capture was bound to; the page was on it after load and after the screenshot. */
  origin: string;
  /**
   * Orca cannot restrict a page's requests to the preview origin (spike 02, Q52): the page could reach any host while
   * it was captured. Recorded on every record so no reader mistakes the evidence for network-isolated.
   */
  browserEgress: "unrestricted";
  /** Origins other than the preview's that the page requested, from Orca's network log. */
  externalOrigins: string[];
  viewport: Viewport;
  /** Absolute path of the PNG in the attempt's local evidence store. */
  screenshotPath: string;
  screenshotSha256: string;
  screenshotBytes: number;
  consoleErrors: string[];
  networkFailures: NetworkFailure[];
  /** The page as Markdown, from Orca's reader. */
  pageText: string;
  /** Set when Orca truncated the console, network, or page text it returned. */
  truncated: { console: boolean; network: boolean; pageText: boolean };
  /** What stabilization saw before the screenshot, or null when it was skipped. */
  stabilized: { width: number; height: number; fonts: boolean; frames: boolean; visibility: string } | null;
  capturedAt: string;
}

const AC_ID = /^AC-[1-9][0-9]{0,3}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function assertRecordIds(acId: string | null, name: string): void {
  if (acId !== null && !AC_ID.test(acId)) throw new Error(`acceptance criterion id must look like AC-1: ${JSON.stringify(acId)}`);
  if (!NAME.test(name)) throw new Error(`evidence name must match ${NAME}: ${JSON.stringify(name)}`);
}

/** Console entries at level error, as Orca's `console --json` lists them, bounded in count and length. */
export function consoleErrors(entries: unknown): string[] {
  if (!Array.isArray(entries)) throw new Error("console entries are not a list");
  return entries
    .filter((e) => isRecord(e) && e.level === "error")
    .slice(0, MAX_CONSOLE_ERRORS)
    .map((e) => String((e as Record<string, unknown>).text ?? "").slice(0, MAX_ENTRY_CHARS));
}

/** Origins in Orca's network log other than `origin`, sorted and unique. */
export function externalOrigins(entries: unknown, origin: string): string[] {
  if (!Array.isArray(entries)) throw new Error("network entries are not a list");
  const seen = new Set<string>();
  for (const e of entries) {
    if (!isRecord(e) || typeof e.url !== "string") continue;
    let o: string;
    try {
      o = new URL(e.url).origin;
    } catch {
      continue;
    }
    if (o !== origin && o !== "null") seen.add(o);
  }
  return [...seen].sort();
}

/** Requests that failed: no response, or a status of 400 or more. */
export function networkFailures(entries: unknown): NetworkFailure[] {
  if (!Array.isArray(entries)) throw new Error("network entries are not a list");
  const out: NetworkFailure[] = [];
  for (const e of entries) {
    if (!isRecord(e) || typeof e.url !== "string") continue;
    const status = typeof e.status === "number" && e.status > 0 ? e.status : null;
    if (status === null || status >= 400) out.push({ url: e.url, method: typeof e.method === "string" ? e.method : "GET", status });
  }
  return out;
}
