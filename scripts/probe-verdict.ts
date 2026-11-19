import Ajv2020 from "ajv/dist/2020";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptDirectories } from "../src/dispatch/attempt";
import { collectOutputs, outputDigest, OutputIntegrityError, type NativeWrite } from "../src/dispatch/output";
import type { Store } from "../src/factory/store";
import { archiveCollection, readCollection } from "../src/factory/skill-store";
import { pinnedFixture } from "./eval-checkout";
import schema from "../skills/_shared/verdict.schema.json";

export function prepareVerdict(git: string, factory: string, commit: string, dirs: AttemptDirectories, refs: {base: string; head:string}, taskId: string) {
  const task = "skills/_shared/evals/tasklist/taskdirs/sort/";
  const parts = ["spec-lead.json","spec.md"].map(name => {
    const bytes = pinnedFixture(git,factory,commit,task + name);
    writeFileSync(join(dirs.taskDir,name),bytes,{flag:"wx",mode:0o400});
    return outputDigest(bytes) + "  " + name + "\n";
  });
  const covers = {baseSha:refs.base,headSha:refs.head,specSetSha256:outputDigest(Buffer.from(parts.join("")))};
  const changes = JSON.parse(pinnedFixture(git,factory,commit,"skills/builder/evals/fixtures/sort-skips-ac3-review.json").toString());
  const approve = JSON.parse(pinnedFixture(git,factory,commit,"skills/_shared/evals/mutations.json").toString()).bases["review-approve"].inline;
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
  const validate = new Ajv2020({strictTypes:false,allowUnionTypes:true}).compile(schema);
  for (const document of [changes,approve]) {
    document.covers = covers;
    document.taskId = taskId;
    if (!validate(document)) throw new Error("invalid bound review fixture");
  }
  if (changes.taskId !== approve.taskId || changes.verdict !== "changes" || approve.verdict !== "approve") throw new Error("bad provenance control");
  mkdirSync(join(dirs.outDir,"verdicts"));
  const file = "verdicts/code-reviewer.json";
  const output = join(dirs.outDir,file);
  const authentic = bytes(changes), replacement = bytes(approve);
  const source = join(dirs.taskDir,"submission.json");
  writeFileSync(source,authentic,{flag:"wx",mode:0o400});
  return {taskId:changes.taskId as string,file,output,source,authentic,replacement,covers};
}

/** The substitution is made by the host between two independent collection checks. */
export function verifyVerdict(dirs: AttemptDirectories, trial: ReturnType<typeof prepareVerdict>, session: string, records: NativeWrite[], store: Store, bundleHash: string) {
    const id = dirs.root.split("/").at(-1)!;
    const expected = new Map([[trial.file,{sessionId:session,role:dirs.role}]]);
    const collect = () => collectOutputs(dirs,{attemptId:id,taskId:trial.taskId},expected,records);
    const captured = collect().get(trial.file);
    if (!captured?.equals(trial.authentic)) throw new Error("authentic native submission differed");
    archiveCollection(store.db,Number(trial.taskId),{attempt:id, role:dirs.role,round:1,base:trial.covers.baseSha,head:trial.covers.headSha,
      bundleHash,files:[{path:trial.file,role:dirs.role,session,sha256:outputDigest(captured),base64:captured.toString("base64")}]});
    writeFileSync(trial.output,trial.replacement);
    try { collect(); throw new Error("substitution was accepted"); }
    catch (error) { if (!(error instanceof OutputIntegrityError) || !error.message.includes("changed after authenticated")) throw error; }
    return readCollection(store.db,id)?.files[0]?.base64 === trial.authentic.toString("base64") &&
      (store.db.query("SELECT COUNT(*) AS n FROM approvals").get() as {n:number}).n === 0;
}
