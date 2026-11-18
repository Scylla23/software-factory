export function* jsonLines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a run killed mid-write leaves a partial last line
    }
    if (isRecord(parsed)) yield parsed;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
