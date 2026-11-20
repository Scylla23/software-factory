import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, realpathSync, readFileSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/dispatch/git";
import { outputDigest } from "../src/dispatch/output";
import { caseInput, revisionFixtureError, stageBlindInputs } from "../scripts/eval-inputs";

test("blind staging exposes only declared files, binds the plan and current spec set, and keeps planted stale hashes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),"stage-case-")));
  try {
    const factory = join(root,"factory"), git = "/usr/bin/git";
    for (const name of ["verifier/evals","security-auditor/evals","spec-reviewer/evals","_shared/evals/tasklist"]) {
      const dest = join(factory,"skills",name);
      mkdirSync(dest,{recursive:true});
      cpSync(join(import.meta.dir,"../skills",name),dest,{recursive:true});
    }
    runGit(git,factory,["init","-q","--template="]);
    runGit(git,factory,["add","skills"]);
    runGit(git,factory,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","fixtures"]);
    const commit = runGit(git,factory,["rev-parse","HEAD"]).toString().trim();
    for (const variant of ["sound-evidence","stale-evidence"]) {
      const input = caseInput(git,factory,commit,"verifier","verifier-02-judge-test-evidence",variant);
      const dir = join(root,crypto.randomUUID()); mkdirSync(dir,{mode:0o700});
      const refs = {base:"a".repeat(40),head:"b".repeat(40)};
      const brief = stageBlindInputs(git,factory,commit,"verifier",input,dir,refs);
      expect(brief.specSet?.files.map(f => f.name)).toEqual(["spec-lead.json","spec.md"]);
      const index = JSON.parse(readFileSync(join(dir,"verification/evidence/index.json"),"utf8"));
      const plan = readFileSync(join(dir,"verification/plan.json"));
      expect(index.baseSha).toBe(refs.base);
      expect(index.headSha).toBe(variant === "sound-evidence" ? refs.head : "2".repeat(40));
      expect(index.planSha256).toBe(outputDigest(plan));
      expect(JSON.parse(plan.toString()).specSetSha256).toBe(brief.specSet!.sha256);
      expect(JSON.stringify(brief)).not.toMatch(/answerKey|evals\/|sound-evidence|stale-evidence/);
      const files = readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e => e.isFile());
      expect(files.length).toBe(Object.keys(input.files).length);
      expect(() => stageBlindInputs(git,factory,commit,"verifier",input,dir,refs)).toThrow("destination");
    }
    const role = "security-auditor", id = "security-auditor-03-spec-stage", variant = "revision-edits-only-the-threat-model";
    const input = caseInput(git,factory,commit,role,id,variant);
    const dir = join(root,"revision"); mkdirSync(dir,{mode:0o700});
    const staged = stageBlindInputs(git,factory,commit,role,input,dir,{base:"a".repeat(40),head:"b".repeat(40)});
    const old = join(dir,"archive/spec/round-1");
    const archived = ["spec-lead.json","spec.md","threat-model.md"].map(name =>
      outputDigest(readFileSync(join(old,name))) + "  " + name + "\n").join("");
    const hash = outputDigest(Buffer.from(archived));
    expect(JSON.parse(readFileSync(join(old,"verdicts/security-auditor.json"),"utf8")).covers.specSetSha256).toBe(hash);
    expect(revisionFixtureError(id + "/" + variant,dir,staged.specSet?.sha256)).toBeNull();
    expect(revisionFixtureError(id + "/" + variant,dir,hash)).toContain("distinct");
    expect(() => revisionFixtureError(id + "/" + variant,dir,undefined)).toThrow("missing spec-set");
    expect(revisionFixtureError(id + "/lead-dropped-a-mitigation",dir,staged.specSet?.sha256)).toBeNull();
    const reviewKey="spec-reviewer-03-revision-breaks-something-else", reviewDir=join(root,"review");
    mkdirSync(reviewDir,{mode:0o700});
    const review=stageBlindInputs(git,factory,commit,"spec-reviewer",caseInput(git,factory,commit,"spec-reviewer",reviewKey),
      reviewDir,{base:"a".repeat(40),head:"b".repeat(40)});
    const priorDir=join(reviewDir,"archive/spec/round-1");
    const digest=outputDigest(Buffer.from(["spec-lead.json","spec.md"].map(name=>outputDigest(readFileSync(join(priorDir,name)))+"  "+name+"\n").join("")));
    expect(JSON.parse(readFileSync(join(priorDir,"verdicts/spec-reviewer.json"),"utf8")).covers.specSetSha256).toBe(digest);
    expect(revisionFixtureError(reviewKey,reviewDir,review.specSet?.sha256)).toBeNull();
    expect(revisionFixtureError(reviewKey,reviewDir,digest)).toContain("distinct");
  } finally { rmSync(root,{recursive:true,force:true}); }
});
