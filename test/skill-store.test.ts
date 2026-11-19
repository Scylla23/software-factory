import { expect, test } from "bun:test";
import { outputDigest } from "../src/dispatch/output";
import { acceptedCollections, archiveCollection, pinFactoryCommit, readCollection } from "../src/factory/skill-store";
import { Store, type Issue } from "../src/factory/store";

test("skill pins survive revisions and collections are atomic, immutable, and staged only after acceptance", () => {
  const store = new Store(":memory:");
  try {
    const sha = "a".repeat(40);
    const t = store.intake({ source: "github", repoId: 1, issueId: 1 } as Issue, sha);
    const attempt = store.plan(t, "dispatch-spec", {});
    expect(pinFactoryCommit(store.db, t.id, sha)).toBe(sha);
    expect(pinFactoryCommit(store.db, t.id, "b".repeat(40))).toBe(sha);
    const bytes = Buffer.from("spec\n");
    const f = { path: "spec.md", role: "spec-lead", session: "child", sha256: outputDigest(bytes), base64: bytes.toString("base64") };
    const c = { attempt: attempt.id, role: "spec-lead", round: 1, base: sha, head: sha, bundleHash: "f".repeat(64), files: [f] };
    expect(() => archiveCollection(store.db, t.id, { ...c, files: [f, { ...f, path: "bad", base64: "YQ==" }] })).toThrow();
    expect(readCollection(store.db, attempt.id)).toBeNull();
    archiveCollection(store.db, t.id, c);
    archiveCollection(store.db, t.id, c);
    expect(() => archiveCollection(store.db, t.id, { ...c, files: [{ ...f, session: "wrong" }] })).toThrow("immutable");
    expect(acceptedCollections(store.db, t.id)).toEqual([]);
    store.finish(attempt.id, "accepted");
    expect(acceptedCollections(store.db, t.id)).toEqual([c]);
  } finally { store.db.close(); }
});
