// Stage the blind inputs without dispatching a contestant or judge.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/dispatch/git";
import { caseInput, stageBlindInputs } from "./eval-inputs";
import { evalCheckout, pinnedFixture } from "./eval-checkout";

const root = realpathSync(mkdtempSync(join(tmpdir(),"eval-inputs-")));
const factory = realpathSync(join(import.meta.dir,"..")), git = "/usr/bin/git";
const commit = runGit(git,factory,["rev-parse","HEAD"]).toString().trim();
try {
  const tree = runGit(git,factory,["ls-tree","-r","--name-only","-z",commit,"--","skills"]).toString();
  const catalogs = tree.split("\0").filter(p => /^skills\/[a-z-]+\/evals\/evals\.json$/.test(p));
  if (!catalogs.length) throw new Error("no pinned eval catalogs");
  const mkdir = () => mkdtempSync(join(root,"project-"));
  const state = mkdir(), empty = mkdir();
  runGit(git,empty,["init","-q","--template="]);
  runGit(git,empty,["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-qm","fixture"]);
  const placeholder = runGit(git,empty,["rev-parse","HEAD"]).toString().trim();
  const revisions = new Map<string, {base:string;head:string}>();
  let variants = 0, withRepos = 0, pilotBindings = 0;
  for (const catalog of catalogs) {
    const role = catalog.split("/")[1]!;
    const cases = JSON.parse(pinnedFixture(git,factory,commit,catalog).toString()).cases;
    for (const c of cases) for (const variant of c.variants ?? [{}]) {
      const input = caseInput(git,factory,commit,role,c.id,variant.id);
      let refs = {base:placeholder,head:placeholder};
      if (input.fixture) {
        const key = input.patch ?? "";
        if (!revisions.has(key)) revisions.set(key,evalCheckout(git,factory,commit,mkdir(),state,input.patch));
        refs = revisions.get(key)!;
        withRepos++;
      } else if (c.pilot !== "self-contained") {
        pilotBindings++;
      }
      stageBlindInputs(git,factory,commit,role,input,mkdir(),refs);
      variants++;
    }
  }
  console.log(JSON.stringify({catalogs:catalogs.length, variants, withFixtureRepository:withRepos, requiresPilotBinding:pilotBindings}));
} finally { rmSync(root,{recursive:true,force:true}); }
