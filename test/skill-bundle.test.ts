import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleDigest, composeInstructions, materializeBundle } from "../src/dispatch/bundle";
import { runGit } from "../src/dispatch/git";
import { makeSandbox, type Sandbox } from "./helpers";

let sb: Sandbox, repo: string, dir: string;
const git = (...args: string[]) => runGit("/usr/bin/git", repo, args).toString().trim();
function commit() {
  git("add", "-A");
  git("-c", "user.name=test", "-c", "user.email=t@example.invalid", "commit", "-qm", "fixture");
  return git("rev-parse", "HEAD");
}
function file(name: string, text: string) {
  const path = join(repo, "skills", name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
beforeEach(() => {
  sb = makeSandbox();
  repo = join(sb.stateRoot, "source");
  dir = join(sb.home, "bundle");
  mkdirSync(repo);
  mkdirSync(dir);
  git("init", "-q");
  file("builder/SKILL.md", "---\nname: builder\n---\nBody one.\n");
  file("_shared/run-contract.md", "Contract.");
  file("builder/evals/fixtures/token", "Hidden.");
});
afterEach(() => sb.cleanup());
const bundle = (sha: string, roots = [sb.worktree]) => materializeBundle("/usr/bin/git", repo, sha, dir, roots);

test("instructions and digest cover the pinned blobs, without evals or frontmatter", () => {
  const pin = commit();
  file("builder/SKILL.md", "other");
  commit();
  file("builder/SKILL.md", "uncommitted");
  const digest = bundle(pin);
  expect(readFileSync(join(dir, "builder/SKILL.md"), "utf8")).toContain("Body one.");
  expect(existsSync(join(dir, "builder/evals"))).toBe(false);
  expect(composeInstructions(dir, "builder", "<project_instructions>P</project_instructions>")).toBe(
    '<factory_skill name="builder">\nBody one.\n</factory_skill>\n\n<factory_run_contract>\nContract.\n</factory_run_contract>\n\n<project_instructions>P</project_instructions>',
  );
  const path = join(dir, "_shared/run-contract.md");
  chmodSync(path, 0o600);
  writeFileSync(path, "Different.");
  expect(bundleDigest(dir)).not.toBe(digest);
});

test("refuses mutable aliases, dot entries, oversize blobs, reachable checkout and oversize composition", () => {
  expect(() => bundle(commit(), [sb.stateRoot])).toThrow("overlaps");
  file("builder/.agents/type", "x");
  expect(() => bundle(commit())).toThrow("unsafe skill");
  rmSync(join(repo, "skills/builder/.agents"), { recursive: true });
  symlinkSync("SKILL.md", join(repo, "skills/builder/link"));
  expect(() => bundle(commit())).toThrow("unsafe skill");
  rmSync(join(repo, "skills/builder/link"));
  file("builder/resource", "a".repeat(256 * 1024 + 1));
  expect(() => bundle(commit())).toThrow("size limit");
  rmSync(join(repo, "skills/builder/resource"));
  bundle(commit());
  expect(() => composeInstructions(dir, "builder", "œ".repeat(140000))).toThrow("byte limit");
});
