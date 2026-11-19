/** Upper bound for one JSONL record; anything longer is reported, not buffered. */
export const MAX_RECORD_BYTES = 8 * 1024 * 1024;

export type JsonlItem =
  | { kind: "record"; line: number; value: Record<string, unknown> }
  | {
      kind: "invalid";
      line: number;
      reason: "malformed" | "oversize" | "not-object";
      /** True for an unterminated last line, the signature of a writer killed mid-record. */
      truncatedTail: boolean;
    };

/**
 * Streams a JSONL file from disk, one item per line, holding at most one record in memory.
 * Blank lines are skipped; every other line yields a record or an invalid item, so callers see corruption.
 */
export function readJsonl(path: string, maxRecordBytes = MAX_RECORD_BYTES): AsyncGenerator<JsonlItem> {
  return parseJsonl(Bun.file(path).stream(), maxRecordBytes);
}

export async function* parseJsonl(stream: AsyncIterable<Uint8Array>, maxRecordBytes: number): AsyncGenerator<JsonlItem> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let parts: Uint8Array[] = [];
  let size = 0;
  let oversize = false;
  let line = 0;

  const append = (bytes: Uint8Array) => {
    if (oversize || bytes.length === 0) return;
    if (size + bytes.length > maxRecordBytes) {
      oversize = true;
      parts = [];
      return;
    }
    parts.push(bytes);
    size += bytes.length;
  };

  const finish = (terminated: boolean): JsonlItem | null => {
    line++;
    const wasOversize = oversize;
    const bytes = concat(parts, size);
    parts = [];
    size = 0;
    oversize = false;
    const invalid = (reason: "malformed" | "oversize" | "not-object"): JsonlItem => ({ kind: "invalid", line, reason, truncatedTail: !terminated });
    if (wasOversize) return invalid("oversize");
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      return invalid("malformed");
    }
    if (text.trim() === "") return null;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return invalid("malformed");
    }
    return isRecord(value) ? { kind: "record", line, value } : invalid("not-object");
  };

  for await (const chunk of stream) {
    let start = 0;
    for (let nl = chunk.indexOf(10, start); nl !== -1; nl = chunk.indexOf(10, start)) {
      append(chunk.subarray(start, nl));
      const item = finish(true);
      if (item) yield item;
      start = nl + 1;
    }
    append(chunk.subarray(start));
  }
  if (size > 0 || oversize) {
    const item = finish(false);
    if (item) yield item;
  }
}

function concat(parts: Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** How many diagnostics a parse keeps verbatim. */
export const DIAGNOSTIC_SAMPLE = 20;

/** Keeps the first `limit` diagnostics and counts all of them, so a corrupt log cannot grow a result without bound. */
export class DiagnosticSample {
  private readonly kept: string[] = [];
  count = 0;

  constructor(private readonly limit = DIAGNOSTIC_SAMPLE) {}

  add(message: string): void {
    this.count++;
    if (this.kept.length < this.limit) this.kept.push(message);
  }

  /** The sample, plus one line saying how many were left out. */
  list(): string[] {
    const omitted = this.count - this.kept.length;
    return omitted > 0 ? [...this.kept, `${omitted} more diagnostics not shown (${this.count} total)`] : [...this.kept];
  }
}

/** Human-readable diagnostic for an invalid item. */
export function describeInvalid(item: Extract<JsonlItem, { kind: "invalid" }>): string {
  const where = item.truncatedTail ? "truncated final record" : "corrupt record";
  return `line ${item.line}: ${where} (${item.reason})`;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
