import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Check } from "./batch-one-cases";

const headings: Record<string, string[]> = {
  architect: ["Modules", "Data ownership", "External boundaries", "Deferred"],
  infra: ["Choices", "Owner prerequisites", "Environments"],
  frontend: ["Screens", "Layout", "Components", "States", "Accessibility", "Dependencies to add"],
  "threat-modeler": [
    "Assets and actors",
    "Entry points",
    "Threats",
    "Proposed acceptance criteria",
    "Required changes to acceptance criteria",
    "Accepted risks",
    "Security path globs",
  ],
};
type Entry = { id: string; kind: string; category: string; packages?: string[] };
type Catalog = { entries: Entry[]; dropped: { id: string }[] };
const tokens = (s: string) => [...s.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
const strip = (s: string) => s.replaceAll("`", "").trim();
function table(text: string) {
  const rows = text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("|") && s.endsWith("|"))
    .map((s) =>
      s
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );
  if (rows.length < 2 || !rows[1]!.every((c) => /^:?-{2,}:?$/.test(c))) return [];
  return rows.slice(2).map((cells) => Object.fromEntries(rows[0]!.map((k, i) => [k.toLowerCase(), cells[i] ?? ""])));
}
export function specialistChecks(
  role: string,
  markdown: string,
  checks: Check[],
  skills: string,
  tracked: ReadonlySet<string>,
  intact: boolean,
) {
  const catalog = (name: string): Catalog => JSON.parse(readFileSync(join(skills, name, "catalog.json"), "utf8"));
  const roleCatalog = role === "threat-modeler" ? undefined : catalog(role);
  const entries = roleCatalog?.entries ?? [];
  const matches = [...markdown.matchAll(/^## ([^\n]+)$/gm)];
  const section = (name: string) => {
    const i = matches.findIndex((m) => m[1]!.trim() === name);
    return i < 0 ? "" : markdown.slice(matches[i]!.index! + matches[i]![0].length, matches[i + 1]?.index).trim();
  };
  const ids = [...section("Curated entries used").matchAll(/^\s*(?:[-*]\s+)?`([^`]+)`/gm)].map((m) => m[1]!);
  const gaps = section("Catalog gaps");
  const choices = table(section("Choices")),
    screens = table(section("Screens")),
    states = table(section("States"));
  const deps = table(section("Dependencies to add")),
    threats = table(section("Threats")),
    points = table(section("Entry points"));
  const categories = ["hosting", "database", "auth", "email", "queues", "payments", "analytics", "ci", "observability"];
  const choice = (key: string) => strip(choices.find((r) => strip(r.category ?? "") === key)?.choice ?? "");
  const lines = markdown.trimEnd().split("\n");
  const list = (str: string) => str.split("\n").filter((s) => /^\s*[-*]\s+/.test(s));
  const run = (id: string): boolean => {
    switch (id) {
      case "one-file":
        return intact;
      case "headings":
        return (
          JSON.stringify(matches.map((m) => m[1]!.trim())) ===
          JSON.stringify([
            "Decision",
            "Options considered",
            "Rationale",
            ...headings[role]!,
            "Curated entries used",
            "Catalog gaps",
            "Assumptions",
          ])
        );
      case "curated-valid":
      case "catalog-ids":
        return section("Curated entries used") !== "" && ids.every((id) => entries.some((e) => e.id === id));
      case "length":
        return lines.length <= 200;
      case "no-vendors":
        return (
          !/\b(Vercel|Cloudflare|Railway|Neon|Turso|Resend|Postmark|Clerk|Tailwind)\b/i.test(markdown) &&
          ![...catalog("infra").entries, ...catalog("frontend").entries].some((e) => new RegExp("(?<![\\w-])" + e.id + "(?![\\w-])", "i").test(markdown))
        );
      case "anti-pattern-cited":
        return /`(?:microservices-first|speculative-generality)`/.test(markdown);
      case "expand-contract":
        return ids.includes("expand-contract-migrations");
      case "cites-code": {
        if (role === "threat-modeler") return points.some((r) => tokens(r["path or file"] ?? "").some((p) => tracked.has(p)));
        const seen = new Set<string>();
        const extensions = new Set([...tracked].map(path => extname(path)));
        for (const line of lines)
          for (const match of line.matchAll(/`([\w.-]+(?:\/[\w.@-]+)*\.[a-z0-9]+)`/gi)) {
            const p = match[1]!;
            if (!p.includes("/") && !extensions.has(extname(p)) && !tracked.has(p)) continue;
            const before = line.slice(0, match.index);
            const after = line.slice(match.index + match[0].length);
            const planned = /\b(?:new|creat(?:e|ed)|add(?:ed)?)\b[^.!?;`]*$/i.test(before) || /^\s*\(new\)/i.test(after);
            if (!tracked.has(p) && !planned) return false;
            seen.add(p);
          }
        return seen.size >= 2;
      }
      case "nine-rows":
        return JSON.stringify(choices.map((r) => strip(r.category ?? ""))) === JSON.stringify(categories);
      case "choices-valid":
        return (
          choices.length > 0 &&
          choices.every((r) => {
            const s = strip(r.choice ?? ""),
              ids = tokens(r.choice ?? "");
            return (
              s.startsWith("existing:") ||
              s === "not needed" ||
              (ids.length > 0 && ids.every((id) => entries.some((e) => e.id === id && e.category === strip(r.category ?? ""))))
            );
          })
        );
      case "unneeded":
        return choice("payments") === "not needed" && choice("analytics") === "not needed";
      case "fits-architecture":
        return !!choice("hosting") && !/cloudflare-workers|vercel/i.test(choice("hosting"));
      case "no-secrets":
        return !/(?:sk|pk|re|whsec)_[A-Za-z0-9]{8,}|^\s*(?:export\s+)?[A-Z_][A-Z_0-9]*=\S/m.test(markdown);
      case "no-versions":
        return !/\b\d+\.\d+\.\d+\b/.test(markdown);
      case "gaps":
        return list(gaps).length >= 2;
      case "existing-rows":
        return ["hosting", "database", "auth", "ci"].every((k) => choice(k).startsWith("existing:") || choice(k) === "not needed");
      case "email-picked":
        return entries.some(
          (e) => e.category === "email" && tokens(choices.find((r) => strip(r.category ?? "") === "email")?.choice ?? "").includes(e.id),
        );
      case "routes":
        return screens.length > 0 && screens.every((r) => strip(r.route ?? "").startsWith("/"));
      case "viewports": {
        const groups = section("Layout")
          .split(/^### .+$/gm)
          .slice(1);
        return (
          groups.length > 0 &&
          groups.every((g) =>
            ["1440x900", "390x844"].every((v) =>
              list(g).some((l) =>
                l
                  .replaceAll("*", "")
                  .replace(/^\s*-\s*/, "")
                  .startsWith(v + ":"),
              ),
            ),
          )
        );
      }
      case "states":
        return (
          screens.length > 0 &&
          screens.every((r) => states.some((s) => s.screen === r.screen && Object.values(s).every((v) => v.trim() !== "")))
        );
      case "deps-valid":
        return (
          !!section("Dependencies to add") &&
          deps.every((r) => {
            const e = entries.find((e) => e.id === strip(r["catalog id"] ?? "") && e.kind === "library");
            if (!e) return false;
            return (r.packages ?? "")
              .split(/[\s,]+/)
              .map(strip)
              .filter(Boolean)
              .every((p) => e.packages?.includes(p));
          })
        );
      case "fonts":
        return new Set(ids.filter((id) => entries.some((e) => e.id === id && e.category === "font"))).size <= 2;
      case "no-dropped":
        return !roleCatalog?.dropped.some(({ id }) => new RegExp("\\b" + id.replaceAll("-", "[- ]") + "\\b", "i").test(markdown));
      case "cmdk":
        return ids.includes("cmdk") && tokens(section("Components")).includes("cmdk");
      case "beautiful-ui":
        return ids.includes("beautiful-ui");
      case "copy-paste":
        return deps
          .filter((r) => strip(r["catalog id"] ?? "") === "beautiful-ui")
          .every((r) => strip(r.install ?? "") === "copy-paste" && /^(?:none|n\/a|-|)$/.test(strip(r.packages ?? "").toLowerCase()));
      case "resolved-in-catalog-or-gap":
        return (
          entries.some((e) => ids.includes(e.id) && (e.id === "react-aria-components" || e.category === "drag-and-drop")) ||
          (!!gaps && !/^none\.?$/i.test(gaps))
        );
      case "ids":
        return (
          threats.length > 0 &&
          threats.every(
            (r, i) => strip(r.id ?? "") === "T-" + (i + 1) && points.some((p) => strip(p.id ?? "") === strip(r["entry point"] ?? "")),
          )
        );
      case "high-verified":
        return (
          threats.length > 0 &&
          threats.every((r) => strip(r.rating ?? "").toLowerCase() !== "high" || (!!r.mitigation?.trim() && !!r["verified by"]?.trim()))
        );
      case "globs":
        return list(section("Security path globs")).length > 0;
      case "required-changes":
        return ["AC-1", "AC-2"].every((ac) => list(section("Required changes to acceptance criteria")).some((l) => l.includes(ac)));
      case "small":
        return threats.length > 0 && threats.length <= 8 && lines.length <= 200;
      default:
        throw new Error("unimplemented specialist check: " + id);
    }
  };
  return Object.fromEntries(checks.filter((c) => c.kind === "deterministic").map((c) => [c.id, run(c.id)]));
}
