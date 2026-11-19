import { expect, test } from "bun:test";
import { join } from "node:path";
import mutations from "../skills/_shared/evals/mutations.json";

test("skill examples, fixture inputs and both mutation control arms validate", () => {
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/validate-skills.cjs")]);
  if (run.exitCode !== 0) throw new Error(run.stdout.toString() + run.stderr.toString());
  const log = run.stdout.toString().split("\n");
  for (const control of mutations.schemaRejects.cases) {
    expect(log.some(line => line.startsWith(`ok   mutation ${control.id} (`) && line.endsWith("rejected as expected)"))).toBe(true);
  }
  for (const control of mutations.joinRejects.cases) {
    expect(log.some(line => line.startsWith(`ok   mutation ${control.id} (`) && !line.includes("rejected as expected"))).toBe(true);
  }
});
