import { mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { isRecord } from "../src/dispatch/jsonl";
import { outputDigest } from "../src/dispatch/output";
import { assertRepoPath } from "../src/github/commit";
import { pinnedFixture } from "./eval-checkout";

const members = ["architecture.md", "frontend.md", "infra.md", "spec-lead.json", "spec.md", "team-brief.md", "threat-model.md"];

/** Only the selected input is returned. Expectations, controls and judges stay in the factory checkout. */
export function caseInput(git: string, factory: string, commit: string, role: string, id: string, variant?: string) {
  if (!/^[a-z]+(?:-[a-z]+)*$/.test(role)) throw new Error("invalid eval role");
  const catalog = JSON.parse(pinnedFixture(git,factory,commit,`skills/${role}/evals/evals.json`).toString());
  const cases = catalog.cases.filter((c: {id:string}) => c.id === id);
  if (cases.length !== 1) throw new Error("unknown or ambiguous eval case");
  const rows = Array.isArray(cases[0].variants) ? cases[0].variants.filter((v: {id:string}) => v.id === variant) : variant ? [] : cases;
  if (rows.length !== 1 || !isRecord(rows[0].input) || !isRecord(rows[0].input.files) || !isRecord(rows[0].input.brief) ||
      rows[0].input.brief.role !== role) throw new Error("invalid eval variant or role");
  const {files,brief,repo} = rows[0].input;
  if (repo && (repo.fixture !== "../../_shared/evals/tasklist" || (repo.patch && !/^patches\/[a-z0-9-]+\.patch$/.test(repo.patch)))) throw new Error("unknown eval repository");
  return {files:files as Record<string,unknown>,brief:brief as Record<string,unknown>,
    fixture: !!repo, patch: repo?.patch?.slice("patches/".length) as string | undefined};
}

function bindShas(value: unknown, refs: {base:string; head:string}, spec?: string, plan?: string): unknown {
  if (Array.isArray(value)) return value.map(item => bindShas(item,refs,spec,plan));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key,v]) => {
    if (typeof v === "string" && key.endsWith("Sha")) {
      if (v === "0".repeat(40)) return [key,refs.base];
      if (v === "1".repeat(40)) return [key,refs.head];
    }
    if (v === "0".repeat(64) && key === "specSetSha256" && spec) return [key,spec];
    if (v === "0".repeat(64) && key === "planSha256" && plan) return [key,plan];
    return [key,bindShas(v,refs,spec,plan)];
  }));
}

function bytesFor(git: string, factory: string, commit: string, role: string, value: unknown) {
  if (isRecord(value) && Object.keys(value).length === 1 && value.inline !== undefined) {
    return Buffer.from(typeof value.inline === "string" ? value.inline : JSON.stringify(value.inline,null,2) + "\n");
  }
  if (typeof value !== "string") throw new Error("invalid eval input source");
  const path = posix.normalize(`skills/${role}/evals/` + value);
  if (!/^skills\/[a-z-]+\/evals\/fixtures\//.test(path) && !/^skills\/_shared\/evals\/tasklist\/(reports|taskdirs)\//.test(path)) throw new Error("eval file outside input fixtures");
  return pinnedFixture(git,factory,commit,path);
}

export function stageBlindInputs(git: string, factory: string, commit: string, role: string, input: ReturnType<typeof caseInput>,
  taskDir: string, refs: {base:string;head:string}) {
  if (realpathSync(taskDir) !== taskDir || readdirSync(taskDir).length || ![refs.base,refs.head].every(s => /^[a-f0-9]{40}$/.test(s))) throw new Error("invalid eval staging destination or revisions");
  const staged = new Map<string,Buffer>();
  const render = (path: string, bytes: Buffer, spec?: string, plan?: string) => {
    if (!path.endsWith(".json")) return bytes;
    const parsed = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    const bound = bindShas(parsed,refs,spec,plan);
    return JSON.stringify(parsed) === JSON.stringify(bound) ? bytes : Buffer.from(JSON.stringify(bound,null,2) + "\n");
  };
  for (const [path,value] of Object.entries(input.files)) {
    assertRepoPath(path);
    if (path.split("/").some(part => part === "evals" || part.startsWith("."))) throw new Error("unsafe staged input name");
    staged.set(path,render(path,bytesFor(git,factory,commit,role,value)));
  }
  const specFiles = members.filter(n => staged.has(n)).map(name => ({name,sha256:outputDigest(staged.get(name)!)}));
  const specSet = staged.has("spec.md") && staged.has("spec-lead.json") ? {
    files: specFiles, sha256: outputDigest(Buffer.from(specFiles.map(f => f.sha256 + "  " + f.name + "\n").join(""))),
  } : undefined;
  const planPath = "verification/plan.json";
  const plan = staged.get(planPath);
  const planHash = plan && outputDigest(render(planPath,plan,specSet?.sha256));
  for (const [path,bytes] of staged) {
    const final = render(path,bytes,specSet?.sha256,planHash);
    if (members.includes(path) && !bytes.equals(final)) throw new Error("circular spec-set fixture");
    const dest = join(taskDir,path);
    mkdirSync(dirname(dest),{recursive:true,mode:0o700});
    writeFileSync(dest,final,{flag:"wx",mode:0o400});
  }
  const brief = bindShas(input.brief,refs,specSet?.sha256,planHash) as Record<string,unknown>;
  return {...brief,baseSha:refs.base,headSha:refs.head,...(specSet ? {specSet} : {})};
}
