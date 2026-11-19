import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, realpathSync, readFileSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/dispatch/git";
import { outputDigest } from "../src/dispatch/output";
import { caseInput, stageBlindInputs } from "../scripts/eval-inputs";

test("blind staging exposes only declared files, binds the plan and current spec set, and keeps planted stale hashes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(),"stage-case-")));
  try {
    const factory = join(root,"factory"), git = "/usr/bin/git";
    for (const name of ["verifier/evals","_shared/evals/tasklist"]) {
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
  } finally { rmSync(root,{recursive:true,force:true}); }
});
