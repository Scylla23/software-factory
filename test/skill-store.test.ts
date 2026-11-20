import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("the pre-merge skill-only v2 keeps its pinned revision when usage accounting is installed", () => {
  const dir=mkdtempSync(join(tmpdir(),"factory-v2-"));
  let s=new Store(join(dir,"state.sqlite"));
  try {
    s.db.exec("DROP TABLE feedback_failures; DROP TABLE owner_feedback; DROP TABLE usage_captures; PRAGMA user_version=2");
    s.db.exec("INSERT INTO tasks(id,source,repo_id,issue_id,issue,state,base,head) VALUES(1,'github',1,1,'{}','done','','')");
    s.db.run("INSERT INTO skill_tasks(task,factory_commit) VALUES(1,?)",["a".repeat(40)]);
    s.db.close(); s=new Store(join(dir,"state.sqlite"));
    expect(s.db.query("PRAGMA user_version").get()).toEqual({user_version:4});
    expect(s.db.query("SELECT factory_commit FROM skill_tasks").get()).toEqual({factory_commit:"a".repeat(40)});
    expect(s.db.query("SELECT count(*) AS count FROM usage_captures").get()).toEqual({count:0});
  } finally {s.db.close();rmSync(dir,{recursive:true,force:true});}
});
