import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { materializeBundle } from "../src/dispatch/bundle";
import { runGit } from "../src/dispatch/git";

/** Disposable factory checkout with its own commit, distinct from both project checkouts. */
export function probeBundle(git: string, parent: string, dest: string, readable: readonly string[], marker: string) {
  const repo = join(parent, "factory-source");
  const hidden = join(repo, "skills/probe-lead/evals/fixtures");
  mkdirSync(hidden, { recursive: true, mode: 0o700 });
  const path = join(hidden, "token.md");
  writeFileSync(path, marker);
  writeFileSync(join(repo, "skills/probe-lead/SKILL.md"), "---\nname: probe-lead\n---\nUse the run brief.\n");
  const command = (...args: string[]) => runGit(git, repo, args).toString().trim();
  command("init", "-q", "--template=");
  command("add", "skills");
  command("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "probe bundle");
  materializeBundle(git, repo, command("rev-parse", "HEAD"), dest, readable);
  const entries = readdirSync(dest, {recursive: true, withFileTypes: true});
  const excluded = entries.every(e => !e.name.startsWith(".") && e.name !== "evals" &&
    (!e.isFile() || !readFileSync(join(e.parentPath, e.name)).includes(Buffer.from(marker))));
  return {path, excluded};
}
