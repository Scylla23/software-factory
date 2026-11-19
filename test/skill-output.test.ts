import Ajv2020 from "ajv/dist/2020";
import verdictSchema from "../skills/_shared/verdict.schema.json";
import reviewChanges from "../skills/builder/evals/fixtures/sort-skips-ac3-review.json";
import mutations from "../skills/_shared/evals/mutations.json";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutSnapshot, createAttempt, type AttemptDirectories, type SkillRole } from "../src/dispatch/attempt";
import { runGit } from "../src/dispatch/git";
import { collectOutputs, outputDigest } from "../src/dispatch/output";
import { makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
let runRoot: string;
const id = crypto.randomUUID();
const identity = { attemptId: id, taskId: "fixture-1" };
const author = { sessionId: "owner", role: "code-reviewer" };
const path = "verdicts/code-reviewer.json";
const expected = new Map([[path, author]]);
const submitted = Buffer.from('{"result":"changes"}\n');
const record = { ...identity, ...author, path, sha256: outputDigest(submitted) };
beforeEach(() => {
  sb = makeSandbox();
  runRoot = join(sb.home, "runs");
});
afterEach(() => sb.cleanup());
function create(role: SkillRole = "code-reviewer", stage = "code") {
  return createAttempt({ runRoot, stateRoot: sb.stateRoot, accountHome: sb.home, project: sb.worktree, role, stage, attemptId: id });
}
function fixture() {
  const attempt = create();
  mkdirSync(join(attempt.outDir, "verdicts"));
  writeFileSync(join(attempt.outDir, path), submitted);
  return attempt;
}
const collect = (attempt: AttemptDirectories, writes = [record]) => collectOutputs(attempt, identity, expected, writes);
test("creates exclusive private role directories, rejecting overlap and reuse", () => {
  for (const [role, stage, copy, agents] of [
    ["builder", "build", false, false], ["spec-lead", "spec", false, true], ["triage", "spec", false, false],
    ["spec-reviewer", "spec", false, false], ["code-reviewer", "code", true, false],
    ["database-auditor", "code", true, false], ["security-auditor", "spec", false, false],
    ["security-auditor", "code", true, false], ["verifier", "judge", false, false],
  ] as const) {
    const attempt = create(role, stage);
    expect(Boolean(attempt.scratchRepo)).toBe(copy);
    expect(Boolean(attempt.agentsDir)).toBe(agents);
    expect(attempt.worktree.endsWith("/snapshot")).toBe(role !== "builder");
    expect(() => create(role, stage)).toThrow();
    rmSync(attempt.root, { recursive: true });
  }
  runRoot = join(sb.stateRoot, "runs");
  expect(() => create()).toThrow("overlaps");
});
test("captures exactly the final submitted bytes for the designated task, dispatch and session", () => {
  const attempt = fixture();
  expect(collect(attempt).get(path)).toEqual(submitted);
  for (const key of ["taskId", "attemptId", "sessionId", "role", "path"])
    expect(() => collect(attempt, [{ ...record, [key]: "wrong" }])).toThrow("authenticated final write");
  expect(() => collect(attempt, [record, { ...record, sessionId: "lead" }])).toThrow("authenticated final write");
  writeFileSync(join(attempt.outDir, path), '{"result":"approve"}\n');
  expect(() => collect(attempt)).toThrow("output bytes changed after authenticated final write");
});
test("rejects a symlink, unexpected entry, oversize file or replaced output directory", () => {
  const attempt = fixture();
  const file = join(attempt.outDir, path);
  const scratch = join(attempt.scratchDir, "spare");
  writeFileSync(scratch, submitted);
  rmSync(file);
  symlinkSync(scratch, file);
  expect(() => collect(attempt)).toThrow("unexpected output");
  rmSync(file);
  writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
  expect(() => collect(attempt)).toThrow("oversize");
  mkdirSync(join(attempt.outDir, "extra"));
  expect(() => collect(attempt)).toThrow("unexpected output");
  renameSync(attempt.outDir, join(attempt.root, "saved"));
  mkdirSync(attempt.outDir);
  expect(() => collect(attempt)).toThrow("directory replaced");
});

test("review baseline and disposable checkout have independent files, git history and git directories", () => {
  const repo = sb.worktree;
  const git = (...args: string[]) => runGit("/usr/bin/git", repo, args).toString().trim();
  git("init", "-q");
  writeFileSync(join(repo, "example"), "committed");
  git("add", "example");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "first");
  const sha = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "example"), "working tree only");
  const attempt = create();
  for (const dir of [attempt.worktree, attempt.scratchRepo!]) checkoutSnapshot("/usr/bin/git", repo, sha, dir);
  writeFileSync(join(attempt.scratchRepo!, "example"), "changed in scratch");
  expect(runGit("/usr/bin/git", attempt.worktree, ["status", "--porcelain"]).length).toBe(0);
  expect(runGit("/usr/bin/git", attempt.worktree, ["show", "HEAD:example"]).toString()).toBe("committed");
  expect(runGit("/usr/bin/git", attempt.scratchRepo!, ["diff"]).toString()).toContain("changed in scratch");
  expect(() => checkoutSnapshot("/usr/bin/git", repo, sha, attempt.worktree)).toThrow("empty");
});

test("collector rejects the other schema-valid verdict for the same task and head", () => {
  const ajv = new Ajv2020({ strictTypes: false, allowUnionTypes: true });
  const validate = ajv.compile(verdictSchema);
  const attempt = create();
  mkdirSync(join(attempt.outDir, "verdicts"));
  const bytes = (document: unknown) => Buffer.from(JSON.stringify(document) + "\n", "utf8");
  const authentic = bytes(reviewChanges);
  const replacement = bytes(mutations.bases["review-approve"].inline);
  expect(reviewChanges.taskId).toBe(mutations.bases["review-approve"].inline.taskId);
  expect(reviewChanges.covers).toEqual(mutations.bases["review-approve"].inline.covers);
  expect([reviewChanges.verdict, mutations.bases["review-approve"].inline.verdict]).toEqual(["changes", "approve"]);
  expect(validate(JSON.parse(authentic.toString()))).toBe(true);
  expect(validate(JSON.parse(replacement.toString()))).toBe(true);
  const receipt = { ...record, taskId: reviewChanges.taskId, sha256: outputDigest(authentic) };
  const capture = () => collectOutputs(attempt, { ...identity, taskId: reviewChanges.taskId }, expected, [receipt]);
  writeFileSync(join(attempt.outDir, path), authentic);
  expect(capture().get(path)).toEqual(authentic);
  writeFileSync(join(attempt.outDir, path), replacement);
  expect(capture).toThrow("output bytes changed after authenticated final write");
});
