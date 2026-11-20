import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planChecks } from "../scripts/eval-verifier-checks";

const skills = join(import.meta.dir, "../skills");
export function capturePlan(refs: { base: string; head: string }) {
  const p = JSON.parse(readFileSync(join(skills, "verifier/evals/fixtures/sort-plan.json"), "utf8"));
  Object.assign(p, { baseSha: refs.base, headSha: refs.head });
  p.criteria.push(
    {
      acId: "AC-4",
      tag: "browser",
      method: "capture",
      captures: [
        {
          id: "c1",
          name: "task-list",
          route: "/tasks?sort=due&dir=asc",
          fixture: "seeded-tasks",
          sides: ["base", "head"],
          viewports: ["desktop", "mobile"],
          expect: {
            headText: [],
            headTextAbsent: [],
            headTextInOrder: ["2 Nov", "10 Nov", "20 Nov"],
            differsFromBase: true,
            allowedConsoleErrors: [],
            visible: "Read dates at both sizes",
          },
        },
      ],
    },
    {
      acId: "AC-5",
      tag: "manual",
      method: "manual",
      manual: { instruction: "Review production dates", expected: "The list follows the due dates." },
    },
  );
  return p;
}
test("the verifier's five planned criteria bind real named tests, capture order and the owner check", () => {
  const refs = { base: "a".repeat(40), head: "b".repeat(40) },
    plan = capturePlan(refs);
  const root = mkdtempSync(join(tmpdir(), "plan-check-"));
  try {
    writeFileSync(join(root, "build-report.json"), JSON.stringify({ specSetSha256: plan.specSetSha256 }));
    const tree = new Map<string, string>([
      [
        "src/task-list/sort.test.ts",
        plan.criteria
          .slice(0, 3)
          .map((r: any) => r.tests[0].name)
          .join("\n"),
      ],
    ]);
    const verify = () =>
      planChecks(new Map([["verification/plan.json", Buffer.from(JSON.stringify(plan))]]), root, skills, refs, true, tree);
    expect(Object.values(verify()).every(Boolean)).toBe(true);
    plan.criteria[4].manual.instruction = " ";
    expect(verify().manual).toBe(false);
    plan.criteria[3].captures[0].expect.headTextInOrder.reverse();
    expect(verify()["order-committed"]).toBe(false);
    plan.criteria[2].tests[0].reproduction = true;
    expect(verify().reproduction).toBe(false);
    tree.clear();
    expect(verify()["tests-exist"]).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
