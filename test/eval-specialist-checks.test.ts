import { expect, test } from "bun:test";
import { join } from "node:path";
import { specialistChecks } from "../scripts/eval-specialist-checks";
const skills = join(import.meta.dir, "../skills");
const grade = (role: string, md: string, ...keys: string[]) =>
  specialistChecks(
    role,
    md,
    keys.map((id) => ({ id, kind: "deterministic", check: id })),
    skills,
    new Set(["src/view.ts"]),
    true,
  );
test("specialist grades check the catalog and source tree belonging to the contestant role", () => {
  const document =
    "## Modules\nRead `src/view.ts` and create `src/new.ts`.\n## Curated entries used\n- `ports-and-adapters`: isolate the provider.\n";
  expect(grade("architect", document, "catalog-ids", "cites-code")).toEqual({ "catalog-ids": true, "cites-code": true });
  expect(
    grade("architect", document.replace("create", "reuse").replace("ports-and-adapters", "unknown"), "catalog-ids", "cites-code"),
  ).toEqual({ "catalog-ids": false, "cites-code": false });
  const choices = "## Choices\n| Category | Choice | Why |\n| --- | --- | --- |\n| email | `resend` | mail |\n";
  expect(grade("infra", choices, "email-picked", "choices-valid", "nine-rows")).toEqual({
    "email-picked": true,
    "choices-valid": true,
    "nine-rows": false,
  });
  expect(grade("infra", choices.replace("resend", "cmdk"), "choices-valid")["choices-valid"]).toBe(false);
});
test("frontend and threat tables must link their own named rows", () => {
  const screens =
    "## Screens\n| Screen | Route |\n| --- | --- |\n| Home | / |\n## States\n| Screen | Loading |\n| --- | --- |\n| Home | spinner |\n";
  expect(grade("frontend", screens, "routes", "states")).toEqual({ routes: true, states: true });
  expect(grade("frontend", screens.replace("spinner", ""), "states").states).toBe(false);
  const threat =
    "## Entry points\n| Id | Path or file |\n| --- | --- |\n| E-1 | `src/view.ts` |\n## Threats\n| Id | Entry point | Rating | Mitigation | Verified by |\n| --- | --- | --- | --- | --- |\n| T-1 | E-1 | high | encode | AC-1 |";
  expect(grade("threat-modeler", threat, "ids", "high-verified", "cites-code")).toEqual({
    ids: true,
    "high-verified": true,
    "cites-code": true,
  });
  expect(grade("threat-modeler", threat.replace("T-1 | E-1", "T-2 | E-2").replace("AC-1", ""), "ids", "high-verified")).toEqual({
    ids: false,
    "high-verified": false,
  });
});

test("architect citations distinguish code paths from qualified identifiers", () => {
  const doc = "Use `tasks.assignee` and `db.exec`. Read `src/view.ts` and create `src/new.ts`.";
  expect(grade("architect", doc, "cites-code")["cites-code"]).toBe(true);
  expect(grade("architect", doc.replace("create", "reuse"), "cites-code")["cites-code"]).toBe(false);
  expect(grade("architect", doc.replace("src/view.ts", "missing.ts"), "cites-code")["cites-code"]).toBe(false);
});
