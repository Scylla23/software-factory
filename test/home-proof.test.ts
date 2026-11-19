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

test("D3 requires the joined child and actual distinct model and effort on both sides of the definition control", async () => {
  const { qualifiesTeamModelProof } = await import("../src/dispatch/home-proof");
  const parent = {
    test: "D3-distinct",
    observedModel: "claude-haiku-5-5",
    parentEffort: "low",
    factoryLogin: false,
    passed: true,
    types: ["probe-member"],
  };
  const control = { ...parent, id: crypto.randomUUID(), control: true, starts: [], children: [] };
  const child = { agent: "child", model: "claude-sonnet-5-5", effort: "medium", briefInSystem: true, bodyInSystem: true };
  const active = {
    ...parent,
    id: crypto.randomUUID(),
    control: false,
    starts: [{ id: "child", role: "probe-member" }],
    children: [child],
  };
  const check = (measured: object, absent: object = control) =>
    qualifiesTeamModelProof({ harness: "claude", version: pinnedVersions.claude, arms: [absent, measured], failures: [] });
  expect(check(active)).toBe(true);
  for (const change of [
    { effort: "low" },
    { model: parent.observedModel },
    { agent: "another" },
    { briefInSystem: false },
    { bodyInSystem: false },
  ])
    expect(check({ ...active, children: [{ ...child, ...change }] })).toBe(false);
  expect(check({ ...active, parentEffort: null })).toBe(false);
  expect(check(active, { ...control, starts: active.starts })).toBe(false);
  expect(check(active, { ...control, id: active.id })).toBe(false);
});
