import { expect, test } from "bun:test";
import { homeSources, pinnedVersions, qualifiesHomeProof, qualifiesNativeRoots, qualifiesReviewIntegrity } from "../src/dispatch/home-proof";

test("native mechanism receipts bind the pinned harness to its role, stage, denied operations and resulting files",()=>{
  const r={role:"spec-reviewer",stage:"spec",harness:"codex",version:pinnedVersions.codex,model:"gpt-6-luna",effort:"low",
    factoryLogin:true,homeAudit:true,control:false,passed:true,filesMatch:true,nativeDenied:true,observedModel:true,thread:crypto.randomUUID()};
  const check=(raw:unknown)=>qualifiesNativeRoots(raw,"spec-reviewer","spec");
  expect(check(r)).toBe(true);
  for(const k of Object.keys(r))expect(check({...r,[k]:null})).toBe(false);
  expect(qualifiesNativeRoots(r,"database-auditor","code")).toBe(false);
});

test("R3 requires paired observations, a quarantined attempt and the registered integrity reason",()=>{
  const head="b".repeat(40),p={session:crypto.randomUUID(),head,headTestsPassed:true,authenticatedChangesArchived:true};
  const n={session:crypto.randomUUID(),head,headTestsPassed:true,inputWritesDenied:true,snapshotWritesDenied:true,inputsIntact:true,snapshotIntact:true,
    quarantined:true,approvals:0,substitution:"denied"};
  const check=(neg:object)=>qualifiesReviewIntegrity("claude",{harness:"claude",version:pinnedVersions.claude,test:"review-integrity",positive:p,negative:neg});
  expect(check(n)).toBe(true);
  for(const key of Object.keys(n))expect(check({...n,[key]:null})).toBe(false);
  expect(check({...n,session:p.session})).toBe(false);
  expect(check({...n,substitution:"detected",escalation:"retry"})).toBe(false);
  expect(check({...n,substitution:"detected",escalation:"skill output integrity escalation: output bytes changed after authenticated final write: verdicts/code-reviewer.json"})).toBe(true);
});

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
    homeAudit: true,
    factoryLogin: true,
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
