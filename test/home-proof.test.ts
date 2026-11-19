import { expect, test } from "bun:test";
import { homeSources, pinnedVersions, qualifiesHomeProof } from "../src/dispatch/home-proof";

test("only independent, isolated positive and negative S1 observations qualify for the pinned harness", () => {
  for (const harness of ["codex", "claude"] as const) {
    const arms = homeSources.flatMap((test) =>
      [true, false].map((control) => ({
        test,
        control,
        sourceListed: control,
        sourceLoaded: control,
        factoryLogin: false,
        passed: true,
        observedModel: harness === "claude" ? "claude-haiku-5-5" : true,
        id: crypto.randomUUID(),
        thread: crypto.randomUUID(),
      })),
    );
    const receipt = { harness, version: pinnedVersions[harness], failures: [], arms };
    expect(qualifiesHomeProof(harness, receipt)).toBe(true);
    expect(qualifiesHomeProof(harness, { ...receipt, failures: ["incomplete"] })).toBe(false);
    expect(qualifiesHomeProof(harness, { ...receipt, version: "new" })).toBe(false);
    expect(qualifiesHomeProof(harness, { ...receipt, arms: arms.slice(1) })).toBe(false);
    for (const a of [
      { factoryLogin: true },
      { sourceLoaded: false },
      { sourceListed: false },
      { control: false },
      { passed: false },
      { observedModel: "other" },
      { id: arms[2]!.id, thread: arms[2]!.thread },
    ])
      expect(qualifiesHomeProof(harness, { ...receipt, arms: [{ ...arms[0], ...a }, ...arms.slice(1)] })).toBe(false);
  }
});
