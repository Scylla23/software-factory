import { isRecord } from "../dispatch/jsonl";

export interface Viewport {
  name: "desktop" | "mobile";
  width: number;
  height: number;
  /** Device scale factor; screenshots are in CSS pixels either way. */
  scale: number;
  /** Touch input and `pointer: coarse`. */
  mobile: boolean;
}

/** The fixed viewports every UI criterion is captured at. */
export const VIEWPORTS: Readonly<Record<Viewport["name"], Viewport>> = {
  desktop: { name: "desktop", width: 1440, height: 900, scale: 1, mobile: false },
  mobile: { name: "mobile", width: 390, height: 844, scale: 3, mobile: true },
};

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
  viewport: Viewport;
  /** Absolute path of the PNG in the evidence dir. */
  screenshotPath: string;
  screenshotSha256: string;
  consoleErrors: string[];
  networkFailures: NetworkFailure[];
  /** The page as Markdown, from Orca's reader. */
  pageText: string;
  /** Set when Orca truncated the console, network, or page text it returned. */
  truncated: { console: boolean; network: boolean; pageText: boolean };
  /** The isolated browser profile the capture ran in. */
  profileId: string;
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

/** Console entries at level error, as Orca's `console --json` lists them. */
export function consoleErrors(entries: unknown): string[] {
  if (!Array.isArray(entries)) throw new Error("console entries are not a list");
  return entries.filter((e) => isRecord(e) && e.level === "error").map((e) => String((e as Record<string, unknown>).text ?? ""));
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
