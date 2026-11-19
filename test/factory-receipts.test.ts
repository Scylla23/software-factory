import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../factory.config";
import { checkAbandonedPreviews, previewId, ProjectChecks } from "../src/factory/checks";
import { Store } from "../src/factory/store";
import { verifyPilot } from "../src/factory/verify";
import { dispatchWorker } from "../src/factory/worker";

test("worker, project check and capture receipts are adopted only for the intended attempt and revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-receipts-"));
  const store = new Store(":memory:"), project = new ProjectChecks(root);
  try {
    const t = store.intake({ source: "github", repoId: 1, issueId: 2, number: 4, title: "zero", body: "", sender: config.ownerId, url: "fixture", revision: "r" }, "a".repeat(40));
    const a = { ...store.plan(t, "dispatch-spec", { head: t.head }), fresh: false };
    const job = join(root, "jobs", a.id);
    mkdirSync(job, { recursive: true });
    const result = { runId: a.id, sessionId: "one", requestedModel: "fixture", observedModel: "fixture", outcome: "completed",
      quarantineWorktree: false, resultText: "AC-1", usage: null };
    const events: string[] = [];
    const dispatch = () => dispatchWorker(store, t, a, "spec", "prompt", (e) => events.push(e), root);
    const save = (value: unknown) => writeFileSync(join(job, "result.json"), JSON.stringify(value));
    save({ output: { result, files: [] } });
    expect((await dispatch()).result.sessionId).toBe("one");
    await dispatch();
    expect(events).toEqual(["recover-worker", "recover-worker"]);
    expect(store.db.query("SELECT attempt FROM audit").all()).toEqual([{ attempt: a.id }]);
    save({ output: { result: { ...result, runId: "foreign" }, files: [] } });
    await expect(dispatch()).rejects.toThrow("another attempt");
    save({ escalated: true, error: "builder deleted a tracked file" });
    await expect(dispatch()).rejects.toThrow("deleted a tracked file");

    const logs = join(root, "project-logs", a.id), dir = join(root, "evidence", a.id);
    mkdirSync(logs, { recursive: true }); mkdirSync(dir, { recursive: true });
    await expect(project.test(t, a)).rejects.toThrow("interrupted project check");
    await expect(verifyPilot(t, a, project, [])).rejects.toThrow("interrupted browser capture");
    const proof = { base: t.base, head: t.head, tested: t.head, checks: [] };
    writeFileSync(join(logs,"completed.json"),JSON.stringify(proof));
    expect(await project.test(t, a)).toEqual(proof);
    writeFileSync(join(logs,"completed.json"),JSON.stringify({ ...proof, tested: "foreign" }));
    await expect(project.test(t, a)).rejects.toThrow("receipt moved");
    const capture = { pr: t.pr, attemptId: a.id, base: t.base, head: t.head, evidenceDir: dir, captures: [], checks: [] };
    writeFileSync(join(dir,"records.json"), JSON.stringify(capture));
    expect(await verifyPilot(t, a, project, [])).toEqual(capture);
    writeFileSync(join(dir,"records.json"), JSON.stringify({ ...capture, attemptId: "foreign" }));
    await expect(verifyPilot(t, a, project, [])).rejects.toThrow("receipt moved");
    const preview = previewId(a.id, "after"), path = join(root,"previews",preview);
    mkdirSync(path, { recursive: true });
    expect(() => checkAbandonedPreviews(root, a.id)).toThrow("still needs teardown");
    rmSync(path, { recursive: true });
    mkdirSync(join(root,"ports"));
    writeFileSync(join(root,"ports","4100.lease"),JSON.stringify({ attempt: preview }));
    expect(() => checkAbandonedPreviews(root, a.id)).toThrow("lease");
    expect(() => checkAbandonedPreviews(root, crypto.randomUUID())).not.toThrow();
  } finally { project.close(); store.db.close(); rmSync(root, { recursive: true, force: true }); }
});
