import { expect, test } from "bun:test";
import { brokerCommands } from "../src/dispatch/broker";
import { reviewChecks } from "../scripts/eval-review-checks";

const expected = {
  role: "code-reviewer", taskId: "sort", round: 1, baseSha: "base", headSha: "head", specSetSha256: "spec",
};
const verdict = {
  ...expected, stage: "code", verdict: "approve", covers: expected, findings: [],
  checks: {
    commands: [{ command: "bun test", exitCode: 0 }],
    acCoverage: ["AC-1", "AC-2", "AC-3"].map(acId => ({ acId, implemented: true, tested: true })),
  },
};

test("review eval approvals join both revisions and require an observed test", () => {
  const key = "code-reviewer-01-good-fix-approves";
  expect(reviewChecks(key, verdict, expected, true, true)).toMatchObject({ identity: true, "ran-tests": true, coverage: true });
  expect(reviewChecks(key, { ...verdict, covers: { ...expected, headSha: "old" } }, expected, true, false))
    .toMatchObject({ identity: false, "ran-tests": false });
  const broker = { ...verdict, checks: { ...verdict.checks, commands: [{ command: brokerCommands().test!, exitCode: 0 }] } };
  expect(reviewChecks(key, broker, expected, true, true)).toMatchObject({ "ran-tests": true });
  expect(reviewChecks(key, broker, expected, true, false)).toMatchObject({ "ran-tests": false });
});

test("the deletion variant requires a blocking test finding and credits the unchanged behavior", () => {
  const key = "code-reviewer-03-test-integrity/declared-deletion";
  const finding = {
    blocking: true, category: "test-integrity", location: { file: "src/task-list/sort.test.ts" }, acIds: [],
  };
  const review = { ...verdict, verdict: "changes", findings: [finding] };
  expect(reviewChecks(key, review, expected, true, true))
    .toMatchObject({ integrity: true, "criteria-credited": true, "no-false-positive": true });
  expect(reviewChecks(key, { ...review, findings: [{ ...finding, blocking: false }] }, expected, true, true))
    .toMatchObject({ integrity: false });
});
