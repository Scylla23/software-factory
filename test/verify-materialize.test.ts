import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { materializeCommit, removeMaterialized } from "../src/verify/materialize";
import { git, makeRepo, makeVerifyEnv, spawnBounded, type VerifyEnv } from "./verify-helpers";

let env: VerifyEnv;
beforeEach(() => {
  env = makeVerifyEnv();
});
afterEach(() => env.cleanup());

describe("test helpers", () => {
  test("test git never finds the factory repo above the test state", () => {
    const bare = join(env.repos, "no-repo");
    mkdirSync(bare);
    expect(() => git(bare, "rev-parse", "--show-toplevel")).toThrow("not a git repository");
  });
});

describe("materializeCommit", () => {
  test("checks out exactly the requested commit, detached, and removes it cleanly", () => {
    const repo = makeRepo(env.repos, "app", [{ "a.txt": "one" }, { "a.txt": "two" }]);
    const m = materializeCommit("/usr/bin/git", { repo: repo.path, sha: repo.shas[0]!, root: env.previewRoot, name: "preview-1", untrustedRoots: env.config.untrustedRoots });
    expect(m.path).toBe(join(env.previewRoot, "preview-1"));
    expect(readFileSync(join(m.path, "a.txt"), "utf8")).toBe("one");
    expect(git(m.path, "rev-parse", "HEAD")).toBe(repo.shas[0]!);
    expect(spawnBounded(["/usr/bin/git", "-C", m.path, "symbolic-ref", "-q", "HEAD"]).exitCode).not.toBe(0); // detached
    writeFileSync(join(m.path, "untracked.txt"), "left by setup");
    removeMaterialized("/usr/bin/git", m);
    expect(existsSync(m.path)).toBe(false);
    expect(git(repo.path, "worktree", "list")).not.toContain("preview-1");
  });

  test("never runs the repo's hooks, which would run in the factory process", () => {
    const repo = makeRepo(env.repos, "app", [{ "a.txt": "one" }]);
    const marker = join(env.repos, "hook-ran");
    const hook = join(repo.path, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\n: > '${marker}'\n`);
    chmodSync(hook, 0o755);
    // The hook is live: a plain checkout runs it.
    git(repo.path, "checkout", "-q", "--detach", repo.shas[0]!);
    expect(existsSync(marker)).toBe(true);
    spawnBounded(["/bin/rm", marker]);
    const m = materializeCommit("/usr/bin/git", { repo: repo.path, sha: repo.shas[0]!, root: env.previewRoot, name: "preview-2", untrustedRoots: env.config.untrustedRoots });
    expect(existsSync(marker)).toBe(false);
    removeMaterialized("/usr/bin/git", m);
  });

  test("refuses abbreviated or unknown commits, an existing target, and a repo agents can write", () => {
    const repo = makeRepo(env.repos, "app", [{ "a.txt": "one" }]);
    const input = { repo: repo.path, sha: repo.shas[0]!, root: env.previewRoot, name: "preview-3", untrustedRoots: env.config.untrustedRoots };
    expect(() => materializeCommit("/usr/bin/git", { ...input, sha: repo.shas[0]!.slice(0, 12) })).toThrow("full lowercase commit id");
    expect(() => materializeCommit("/usr/bin/git", { ...input, sha: "0".repeat(40) })).toThrow();
    expect(() => materializeCommit("/usr/bin/git", { ...input, name: "../escape" })).toThrow("worktree name");
    mkdirSync(join(env.previewRoot, "preview-3"));
    expect(() => materializeCommit("/usr/bin/git", input)).toThrow("already exists");
    expect(() => materializeCommit("/usr/bin/git", { ...input, name: "preview-4", untrustedRoots: [env.repos] })).toThrow("agent-writable");
  });

  test("a tree that is not a commit is refused, not checked out", () => {
    const repo = makeRepo(env.repos, "app", [{ "a.txt": "one" }]);
    const tree = git(repo.path, "rev-parse", `${repo.shas[0]!}^{tree}`);
    expect(() => materializeCommit("/usr/bin/git", { repo: repo.path, sha: tree, root: env.previewRoot, name: "preview-5", untrustedRoots: [] })).toThrow();
    expect(existsSync(join(env.previewRoot, "preview-5"))).toBe(false);
  });
});
