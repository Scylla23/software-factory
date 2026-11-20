import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGit } from "../src/dispatch/git";
import { assertRepoPath } from "../src/github/commit";

const fixture = "skills/_shared/evals/tasklist";
export function pinnedFixture(git: string, factory: string, commit: string, path: string) {
  assertRepoPath(path);
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^skills\/[a-z_-]+\/evals\//.test(path)) throw new Error("invalid eval fixture identity");
  const data = runGit(git,factory,["ls-tree","-l","-z",commit,"--",path]).toString();
  const entry = /^100644 blob ([a-f0-9]{40}) +(\d+)\t([^\0]+)\0$/.exec(data);
  if (!entry || entry[3] !== path || Number(entry[2]) > 1024 * 1024) throw new Error("invalid pinned fixture file");
  return runGit(git,factory,["cat-file","blob",entry[1]!]);
}

/** Commit only the case's base files and patched tree; the case name and patch stay outside the checkout. */
export function evalCheckout(git: string, factory: string, commit: string, project: string, state: string, patch?: string) {
  if (readdirSync(project).length) throw new Error("eval checkout must start empty");
  const projectGit = (...args: string[]) => runGit(git,project,args).toString().trim();
  const save = () => {
    projectGit("add","-A");
    projectGit("-c","user.name=Factory","-c","user.email=factory@example.invalid","-c","core.hooksPath=/dev/null","commit","-qm","Project revision");
    return projectGit("rev-parse","HEAD");
  };
  const prefix = fixture + "/base/";
  const entries = runGit(git,factory,["ls-tree","-r","--name-only","-z",commit,"--",prefix]).toString().split("\0").filter(Boolean);
  if (!entries.length || entries.length > 256) throw new Error("invalid eval base tree");
  projectGit("init","-q","--template=");
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".txt")) throw new Error("invalid fixture checkout path");
    const dest = entry.slice(prefix.length,-4);
    assertRepoPath(dest);
    if (dest.split("/").some(part => part.startsWith("."))) throw new Error("unexpected hidden checkout entry");
    const path = join(project,dest);
    mkdirSync(dirname(path),{recursive:true});
    writeFileSync(path,pinnedFixture(git,factory,commit,entry),{flag:"wx"});
  }
  const base = save();
  if (!patch) return {base,head:base};
  if (!/^[a-z0-9-]+\.patch$/.test(patch)) throw new Error("invalid fixture patch name");
  const patchFile = join(state,crypto.randomUUID());
  writeFileSync(patchFile,pinnedFixture(git,factory,commit,fixture + "/patches/" + patch),{mode:0o400,flag:"wx"});
  projectGit("apply","--",patchFile);
  return {base,head:save()};
}
