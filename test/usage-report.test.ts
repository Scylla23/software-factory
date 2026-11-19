import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../factory.config";
import { Store, type Task } from "../src/factory/store";
import { Uncertain } from "../src/factory/machine";
import { dispatchWorker } from "../src/factory/worker";
import { costReport, statusReport } from "../src/usage/report";
import { recordFeedback } from "../src/usage/feedback";
import { recordInterrupted, recordUsage, type MeterJob } from "../src/usage/store";
import type { RunUsage } from "../src/usage/capture";

let root: string, store: Store, task: Task;
const issue = { source: "github", number: 9, repoId: config.pilot.repoId, issueId: 145, title: "", body: "", sender: config.ownerId,
  revision: "r", url: "https://github.com/Scylla23/factory-pilot/issues/9" } as const;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "factory-meter-"));
  store = new Store(join(root,"factory.sqlite"));
  task = store.move(store.intake(issue, "a".repeat(40)), "spec_drafting", { pr: 22 });
});
afterEach(() => { store.db.close(); rmSync(root, { recursive: true, force: true }); });
function job(action: string): MeterJob {
  const a = store.plan(task, action, {});
  return { id: a.id, base: task.base, head: task.head, prompt: "fixture", agent: { harness: "codex", effort: "low", model: "gpt-6-luna" } };
}
function run(j: MeterJob): RunUsage {
  return { harness: "codex", runId: j.id, sessionId: crypto.randomUUID(), requestedModel: j.agent.model, observedModel: j.agent.model,
    outcome: "completed", usage: { harness: "codex", inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 20,
      outputTokens: 20, reasoningOutputTokens: 10 } };
}

test("interruption, final receipt and replay preserve one audit with the frozen effort and revisions", async () => {
  const j = job("dispatch-builder");
  const dir = join(root,"jobs",j.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir,"job.json"), JSON.stringify({ ...j, role: "builder" }));
  writeFileSync(join(dir,"result.json"),JSON.stringify({ error:"supervisor failed" }));
  const a = { ...store.plan(task,"dispatch-builder",{}), fresh:false };
  const dispatch = () => dispatchWorker(store,task,a,"builder",j.prompt,() => {},root);
  await expect(dispatch()).rejects.toThrow("supervisor failed");
  expect(costReport(store.db,"task").groups[0]).toMatchObject({ runs:1, tokens:null, apiEquivalentUsd:null });
  const result = { ...run(j), observedModel:"gpt-6.2-sol", resultText:"ok", quarantineWorktree:false };
  writeFileSync(join(dir,"result.json"),JSON.stringify({ output:{ result, files:[] } }));
  await dispatch();
  await dispatch();
  expect(store.db.query("SELECT * FROM audit").all()).toMatchObject([{ attempt:j.id, task:task.id, stage:"spec_drafting", session:result.sessionId,
    requested_model:"gpt-6-luna", observed_model:"gpt-6.2-sol", effort:"low", prompt_revision:new Bun.CryptoHasher("sha256").update("fixture").digest("hex"),
    base:j.base,head:j.head,outcome:"completed" }]);
  expect(costReport(store.db,"stage").groups).toMatchObject([{ stage:"spec_drafting",runs:1,tokens:120 }]);
  expect(costReport(store.db,"project").groups).toMatchObject([{ project:"Scylla23/factory-pilot",runs:1,tokens:120 }]);
  const report = costReport(store.db,"model");
  expect(report.groups).toMatchObject([{ model:"gpt-6.2-sol",runs:1,tokens:120,tokenCoverage:"complete",costCoverage:"complete" }]);
  expect(report.groups[0]!.apiEquivalentUsd).toBeCloseTo(0.000334, 10);
  expect(report.modelFlags).toMatchObject([{ attempt:j.id,flag:"mismatch",requested:"gpt-6-luna",observed:"gpt-6.2-sol" }]);
});

test("partial sums, model breakdown, retry, escalation and owner feedback survive repeated reporting", async () => {
  const j = job("dispatch-spec");
  const data = { inputTokens:1, outputTokens:3, cacheCreationInputTokens:2, cacheReadInputTokens:4, costUsd:0.1 };
  await recordUsage(store.db,task,j,{ ...run(j),harness:"claude",observedModel:"a",
    usage:{ harness:"claude",totalCostUsd:0.4,byModel:{ a:data, b:{ ...data,costUsd:0.3 } } } },root);
  const retry = job("dispatch-spec-after-login");
  await recordInterrupted(store.db,task,retry,root,root);
  store.move(task,"escalated",{ reason:"fixture" });
  store.record(task.id,{kind:"comment", id:45, actor:config.ownerId, sha:task.head, reason:"owner requested spec revision", accepted:false});
  const comment = { user:{id:config.ownerId},id:99, body:"document this",commit_id:task.head };
  for (const body of ["draft","final"]) {
    recordFeedback(store.db,task.id,"inline",[ { ...comment,body }, { ...comment,id:100,user:{ id:0 } } ]);
  }
  expect(store.db.query("SELECT id,body FROM owner_feedback").all()).toEqual([{ id:99,body:"final" }]);
  const report = costReport(store.db,"task");
  expect(report.groups).toMatchObject([{ task:task.id,runs:2,tokens:20,apiEquivalentUsd:0.4,tokenCoverage:"partial",costCoverage:"partial" }]);
  expect(report.modelFlags).toContainEqual({ task:task.id,attempt:retry.id,flag:"unknown",requested:retry.agent.model,observed:null });
  expect(report.signals.retries).toMatchObject([{ attempt:retry.id,ordinal:2 }]);
  expect(report.signals.escalations).toMatchObject([{ task:task.id, reason:"fixture" }]);
  expect(report.signals.ownerComments.map(r=>r.url)).toEqual(["https://github.com/Scylla23/factory-pilot/pull/22#issuecomment-45",
    "https://github.com/Scylla23/factory-pilot/pull/22#discussion_r99"]);
  expect(costReport(store.db,"model").groups).toMatchObject([{model:"a",tokens:10,apiEquivalentUsd:0.1},{model:"b",tokens:10,apiEquivalentUsd:0.3},
    {model:"unknown",tokens:null,apiEquivalentUsd:null}]);
  expect(statusReport(store.db)[0]).toMatchObject({id:task.id,state:"escalated",tokens:20,apiEquivalentUsd:0.4,tokenCoverage:"partial"});
});

test("readonly commands report a v1 database before and after atomic schema upgrade", async () => {
  const j = job("dispatch-builder");
  const r = run(j);
  await recordUsage(store.db,task,j,r,root);
  const expected = costReport(store.db,"task");
  store.db.exec("DROP TABLE usage_captures; DROP TABLE owner_feedback; PRAGMA user_version=1");
  const cli = join(import.meta.dir,"../src/factory/cli.ts");
  const preload = join(root,"config.ts");
  writeFileSync(preload, `import { config } from ${JSON.stringify(join(import.meta.dir,"../factory.config.ts"))}; config.stateRoot=${JSON.stringify(root)};`);
  async function invoke(...args: string[]) {
    const proc = Bun.spawn([process.execPath,"--preload",preload,cli,...args],{ stdout:"pipe",stderr:"pipe" });
    const [out,err,code] = await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
    return { out,err,code };
  }
  for (const dimension of ["task","project","stage","model"] as const) {
    const command = await invoke("cost","--by",dimension);
    expect(command.code).toBe(0);
    expect(JSON.parse(command.out)).toEqual(costReport(store.db,dimension));
  }
  const status = await invoke("status");
  expect(JSON.parse(status.out)).toEqual(statusReport(store.db));
  expect((await invoke("cost","--by","invalid")).code).toBe(2);
  expect(store.db.query("PRAGMA user_version").get()).toEqual({user_version:1});
  store.db.close();
  store = new Store(join(root,"factory.sqlite"));
  expect(costReport(store.db,"task")).toEqual(expected);
  expect(store.db.query("SELECT model_flag FROM usage_captures").all()).toEqual([{ model_flag:"match" }]);
});

for (const [name, elapsed, pid, message] of [
  ["timeout", 2_000_000, process.pid, "worker completion is uncertain"],
  ["missing launcher", 5_001, undefined, "worker startup is uncertain"],
  ["disappeared worker", 5_001, 2_147_483_647, "unsettled worker disappeared"],
] as const) test("dispatch records uncertain usage for " + name, async () => {
  const attempt = store.plan(task, "dispatch-spec", {});
  const clock = spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValue(1000 + elapsed);
  try {
    const error = await dispatchWorker(store,task,attempt,"spec","probe",() => {},root,() => pid).catch(e => e);
    expect(error).toBeInstanceOf(Uncertain);
    expect(error.message).toContain(message);
    expect(store.db.query("SELECT attempt,outcome FROM audit").all()).toEqual([{ attempt:attempt.id, outcome:"uncertain" }]);
    expect(costReport(store.db,"task").groups).toMatchObject([{ tokens:null, tokenCoverage:"unknown", apiEquivalentUsd:null }]);
  } finally { clock.mockRestore(); }
});
