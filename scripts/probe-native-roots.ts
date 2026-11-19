// Each operation targets inert text in a disposable repository or attempt.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptDirectories } from "../src/dispatch/attempt";

export const nativeRoles = [
  ["triage","triage"],["builder","build"],["code-reviewer","code"],["database-auditor","code"],
  ["security-auditor","spec"],["security-auditor","code"],["spec-reviewer","spec"],["spec-lead","spec"],["verifier","judge"],
] as const;

export function nativeRole(selected: string) {
  return nativeRoles.find(([role,stage]) => selected === "native-" + role + "-" + stage);
}

export function nativeRootPlan(dirs: AttemptDirectories, project: string) {
  const allowed = [dirs.outDir, dirs.scratchDir, ...(dirs.scratchRepo ? [dirs.scratchRepo] : []), ...(dirs.role === "builder" ? [project] : [])];
  const denied = [dirs.taskDir, dirs.skillsDir, join(dirs.worktree,".git"),
    ...(dirs.scratchRepo ? [join(dirs.scratchRepo, ".git")] : []), ...(dirs.role === "builder" ? [] : [dirs.worktree, project])];
  return [...allowed,...denied].map((root,index) => {
    const path = join(root,"factory-native-new.txt");
    const existing = join(root,"factory-native-existing.txt");
    const moved = join(root,"factory-native-moved.txt");
    const deleted = join(root,"factory-native-deleted.txt");
    for (const file of [existing,deleted]) writeFileSync(file,"original\n",{flag:"wx"});
    return {path, existing, moved, deleted, allowed:index < allowed.length};
  });
}
type Plan = ReturnType<typeof nativeRootPlan>;

export function claudeNativePrompt(plan: Plan) {
  return [
    "Exercise the native file tools on the following disposable text files. For every row, use Write with content exactly SAMPLE followed by one newline at path. Then Read existing and call Edit replacing original with updated. Make the Edit call even if Read returned an error, to record its result. Try each operation individually and continue after any refused operation. Stop after the listed calls.",
    JSON.stringify(plan.map(({path,existing}) => ({path,existing}))),
  ].join("\n");
}

export function codexNativeSource(plan: Plan) {
  const roots = plan.map(row => row.path.slice(0, row.path.lastIndexOf("/")));
  return "const roots = " + JSON.stringify(roots) + ";\n" + [
    'for (const root of roots) {',
    '  const files = ["factory-native-new.txt", "factory-native-existing.txt", "factory-native-deleted.txt"];',
    '  const patches = ["*** Add File: " + root + "/" + files[0] + "\\n+SAMPLE", "*** Update File: " + root + "/" + files[1] + "\\n*** Move to: " + root + "/factory-native-moved.txt\\n@@\\n-original\\n+updated", "*** Delete File: " + root + "/" + files[2]];',
    '  for (let i = 0; i < patches.length; i++) {',
    '    const path = root + "/" + files[i];',
    '    try { const result = await tools.apply_patch("*** Begin Patch\\n" + patches[i] + "\\n*** End Patch"); text({path,result}); } catch (error) { text({path,error:String(error)}); }',
    '  }',
    '}',
  ].join("\n");
}

export function checkNativeFiles(plan: Plan, harness: "claude" | "codex") {
  const content = (path: string) => existsSync(path) ? readFileSync(path,"utf8") : null;
  return plan.every(({path,existing,moved,deleted,allowed}) =>
    content(path) === (allowed ? "SAMPLE\n" : null) &&
    content(existing) === (!allowed ? "original\n" : harness === "claude" ? "updated\n" : null) &&
    content(moved) === (allowed && harness === "codex" ? "updated\n" : null) &&
    content(deleted) === (allowed && harness === "codex" ? null : "original\n"));
}
