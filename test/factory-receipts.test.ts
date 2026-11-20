import { expect, test } from "bun:test";
import { lstatSync, realpathSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../factory.config";
import { checkAbandonedPreviews, previewId, ProjectChecks } from "../src/factory/checks";
import { Uncertain } from "../src/factory/machine";
import { Store } from "../src/factory/store";
import { verifyPilot } from "../src/factory/verify";
import { collectOutputs, outputDigest } from "../src/dispatch/output";
import { cleanWorkerResult, dispatchWorker, workerFailure } from "../src/factory/worker";

function triageOutput(id: string, base: string, session: string) {
  return { attempt: id, role: "triage", round: 1, base, head: base, bundleHash: "a".repeat(64),
    files: [{ path: "triage.json", role: "triage", session, base64: "e30=", sha256: outputDigest(Buffer.from("{}")) }] };
}
test("worker, project check and capture receipts are adopted only for the intended attempt and revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-receipts-"));
  const store = new Store(":memory:"), project = new ProjectChecks(root);
  try {
    const t = store.intake({ source: "github", repoId: 1, issueId: 2, number: 4, title: "zero", body: "", sender: config.ownerId, url: "fixture", revision: "r" }, "a".repeat(40));
    const a = { ...store.plan(t, "dispatch-spec", { head: t.head }), fresh: false };
    const job = join(root, "jobs", a.id);
    mkdirSync(job, { recursive: true });
    const result = { runId: a.id, sessionId: "one", requestedModel: "fixture", observedModel: "fixture", promptRevision: "d".repeat(64), outcome: "completed",
      quarantineWorktree: false, bundleHash: "a".repeat(64), resultText: "completed", usage: null };
    const events: string[] = [];
    const dispatch = () => dispatchWorker(store, t, a, "triage", "{}", (e) => events.push(e), root);
    const save = (value: unknown) => writeFileSync(join(job, "result.json"), JSON.stringify(value));
    save({ output: { result, files: [] } });
    await expect(dispatch()).rejects.toThrow("authenticated skill collection");
    events.length = 0;
    save({ output: { result, files: [], collection: triageOutput(a.id, t.base, "one") } });
    expect((await dispatch()).result.sessionId).toBe("one");
    const completed = await dispatch();
    completed.result.noKnownSurvivors = true;
    completed.result.quarantineReasons = [];
    await cleanWorkerResult(completed.result, async () => { rmSync(join(job, "absent"), {recursive: true}); });
    expect(completed.result.quarantineReasons[0]).toContain("worker cleanup failed");
    expect(completed.result.quarantineWorktree).toBe(true);
    expect(completed.collection).toEqual(triageOutput(a.id, t.base, "one"));
    save({output: completed});
    await expect(dispatch()).rejects.toBeInstanceOf(Uncertain);
    expect(events).toEqual(["recover-worker", "recover-worker", "recover-worker"]);
    expect(store.db.query("SELECT attempt,prompt_revision FROM audit").all()).toEqual([{ attempt: a.id, prompt_revision: "d".repeat(64) }]);
    save({ output: {result: {...result, promptRevision: undefined}, files: []} });
    await expect(dispatch()).rejects.toThrow("dispatched prompt revision");
    save({ output: { result: { ...result, runId: "foreign" }, files: [] } });
    await expect(dispatch()).rejects.toThrow("another attempt");
    save({ escalated: true, error: "builder deleted a tracked file" });
    await expect(dispatch()).rejects.toBeInstanceOf(Uncertain);

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

test("a live launcher can take longer than five seconds to claim its attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-late-claim-"));
  const s = new Store(":memory:");
  let child: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined;
  try {
    const t = s.intake({ source: "github", repoId: 1, issueId: 2, number: 4, title: "stock", body: "", sender: config.ownerId, revision: "r", url: "fixture" }, "a".repeat(40));
    const a = s.plan(t, "dispatch-spec", {});
    const result = await dispatchWorker(s, t, a, "triage", "{}", () => {}, root, (dir, id) => {
      const output = { result: { runId: id, sessionId: "delayed", requestedModel: "fixture", observedModel: "fixture",
        promptRevision: "d".repeat(64), outcome: "completed", bundleHash: "a".repeat(64), resultText: "completed", usage: null }, files: [], collection: triageOutput(id, t.base, "delayed") };
      child = Bun.spawn([process.execPath, "-e", `
        await Bun.sleep(5500);
        await Bun.write("claim", String(process.pid));
        await Bun.write("result.tmp", process.argv[1]);
        require("node:fs").renameSync("result.tmp","result.json");
      `, JSON.stringify({ output })], { cwd: dir, stdout: "ignore", stderr: "ignore" });
      return child.pid;
    });
    expect(result.result.sessionId).toBe("delayed");
    expect(await child!.exited).toBe(0);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    s.db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("post-submission byte mismatch records interrupted usage without accepting a skill collection or verdict", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "factory-output-receipt-")));
  const s = new Store(":memory:");
  try {
    const t = s.intake({ source: "github", repoId: 1, issueId: 2, number: 4, title: "repro", body: "", sender: config.ownerId, revision: "r", url: "fixture" }, "a".repeat(40));
    const a = s.plan(t, "code-review", {});
    const dir = join(root, "jobs", a.id), outDir = join(dir, "out"), path = "verdict.json";
    mkdirSync(outDir, {recursive: true});
    const author = {sessionId: "review-session", role: "code-reviewer"};
    const identity = {taskId: String(t.id), attemptId: a.id};
    writeFileSync(join(outDir, path), "other bytes");
    const outputIdentity = lstatSync(outDir, {bigint: true});
    try {
      collectOutputs({outDir, outputIdentity}, identity, new Map([[path,author]]),
        [{...author,...identity,path,sha256: outputDigest(Buffer.from("submitted bytes"))}]);
      throw new Error("collector accepted a mismatch");
    } catch (error) {
      writeFileSync(join(dir, "result.json"), JSON.stringify(workerFailure(error)));
    }
    await expect(dispatchWorker(s,t,a,"reviewer","{}",() => {},root)).rejects.toThrow("skill output integrity escalation: output bytes changed");
    expect(s.db.query("SELECT attempt FROM skill_collections").all()).toEqual([]);
    expect(s.db.query("SELECT outcome FROM audit").all()).toEqual([{outcome:"uncertain"}]);
    expect(s.db.query("SELECT id FROM approvals").all()).toEqual([]);
  } finally { s.db.close(); rmSync(root, {recursive: true, force: true}); }
});
