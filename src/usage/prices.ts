// USD per million tokens at Standard API rates. Cache writes use the short retention rate by default.
export const priceDate = "2026-11-20";
const anthropic = "https://platform.claude.com/docs/en/about-claude/pricing";
const openai = "https://developers.openai.com/api/docs/pricing.md";
type Price = { input: number; output: number; read: number; write: number; longWrite: number; source: string };
const prices = new Map<string, Price>([
  ["claude-opus-5-5", { input: 4, output: 20, read: 0.2, write: 5, longWrite: 8, source: anthropic }],
  ["claude-sonnet-5-5", { input: 2, output: 10, read: 0.1, write: 2.5, longWrite: 4, source: anthropic }],
  ["claude-fable-5-2", { input: 8, output: 40, read: 0.2, write: 10, longWrite: 16, source: anthropic }],
  ["claude-haiku-5-5", { input: 0.1, output: 0.5, read: 0.01, write: 0.125, longWrite: 0.2, source: anthropic }],
  ["gpt-6.2-sol", { input: 2, output: 10, read: 0.1, write: 2.5, longWrite: 5, source: openai }],
  ["gpt-6.2-astra", { input: 8, output: 40, read: 0.4, write: 10, longWrite: 20, source: openai }],
  ["gpt-6.1-terra", { input: 1, output: 5, read: 0.05, write: 1.25, longWrite: 2.5, source: openai }],
  ["gpt-6-luna", { input: 0.1, output: 0.5, read: 0.01, write: 0.125, longWrite: 0.25, source: openai }],
]);

export function priceFor(observedModel: string | null) {
  return prices.get(observedModel ?? "") ?? null;
}

export interface Tokens {
  // Input includes unclassified writes when the provider omits the write bucket.
  input: number;
  cacheRead: number;
  cacheWrite: number | null;
  output: number;
  reasoning: number | null;
}

export function estimate(model: string | null, t: Tokens, longWrites = 0, perRequest = false) {
  const p = priceFor(model);
  if (!p) return null;
  if (t.cacheWrite === null) return null;
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  const longCodex = perRequest && model?.startsWith("gpt-") && prompt > 272_000;
  const haikuFactor = perRequest && model === "claude-haiku-5-5" && prompt > 100_000 ? 5 : 1;
  const inputCost = t.input * p.input + t.cacheRead * p.read + (t.cacheWrite - longWrites) * p.write + longWrites * p.longWrite;
  return haikuFactor * (inputCost * (longCodex ? 2 : 1) + t.output * p.output * (longCodex ? 1.5 : 1)) / 1_000_000;
}
