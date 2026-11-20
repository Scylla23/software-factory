import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitWriteProtectedPaths, runGit } from "./git";
import { MAX_INSTRUCTIONS_BYTES } from "./instructions";
import { overlaps } from "./policy";
import { readRegularFile } from "./regular-file";

const FILE_LIMIT = 256 * 1024;
const BUNDLE_LIMIT = 2 * 1024 * 1024;
const ENTRY_LIMIT = 1024;
const SEGMENT = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/;

function hashEntry(hash: ReturnType<typeof createHash>, name: string, bytes: Buffer) {
  hash.update(name).update("\0").update(createHash("sha256").update(bytes).digest());
}

/** The digest includes each relative path as well as its contents, in byte order. */
export function bundleDigest(dir: string) {
  if (realpathSync(dir) !== dir) throw new Error("skill bundle path is not canonical");
  const files: string[] = [];
  let entries = 0;
  function visit(rel: string) {
    const items = readdirSync(join(dir, rel), { withFileTypes: true });
    if (!items.length) throw new Error("empty directory in skill bundle");
    for (const item of items) {
      if (++entries > ENTRY_LIMIT || !SEGMENT.test(item.name) || item.name === "evals") throw new Error("unexpected skill bundle entry");
      const name = join(rel, item.name);
      if (item.isDirectory()) visit(name);
      else if (item.isFile()) files.push(name);
      else throw new Error(`non-regular bundle entry ${name}`);
    }
  }
  visit("");
  const hash = createHash("sha256");
  let total = 0;
  for (const path of files.sort()) {
    const bytes = readRegularFile(join(dir, path), FILE_LIMIT);
    if ((total += bytes.length) > BUNDLE_LIMIT) throw new Error("bundle exceeds byte limit");
    hashEntry(hash, path, bytes);
  }
  return hash.digest("hex");
}

export function materializeBundle(git: string, repo: string, commit: string, dir: string, readable: readonly string[]) {
  repo = realpathSync(repo);
  if (realpathSync(dir) !== dir || readdirSync(dir).length) throw new Error("skill destination must be canonical and empty");
  for (const source of [repo, ...gitWriteProtectedPaths(git, repo)]) {
    for (const root of [dir, ...readable]) {
      if (overlaps(source, realpathSync(root))) throw new Error("skill source overlaps agent-readable root");
    }
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || runGit(git, repo, ["cat-file", "-t", commit]).toString().trim() !== "commit")
    throw new Error("skills require a full commit id");
  const tree = runGit(git, repo, ["ls-tree", "-r", "-z", "-l", commit, "--", "skills"]);
  const records = new TextDecoder("utf-8", { fatal: true }).decode(tree).split("\0").filter(Boolean);
  const hash = createHash("sha256");
  const files: { path: string; size: number; oid: string }[] = [];
  let total = 0;
  for (const entry of records) {
    const match = /^(\d+) (\w+) ([a-f0-9]+) +(-|\d+)\tskills\/(.+)$/s.exec(entry);
    if (!match) throw new Error("invalid skill tree entry");
    const [, mode, type, oid, length, path] = match;
    const parts = path!.split("/");
    if (parts.slice(0, -1).includes("evals")) continue;
    if (!parts.every(p => SEGMENT.test(p)) || !["100644", "100755"].includes(mode!) || type !== "blob")
      throw new Error(`unsafe skill entry ${path}`);
    const size = Number(length);
    if (!Number.isSafeInteger(size) || size < 0 || size > FILE_LIMIT || (total += size) > BUNDLE_LIMIT || files.length >= ENTRY_LIMIT)
      throw new Error("bundle exceeds size limit");
    files.push({ path: path!, oid: oid!, size });
  }
  if (!files.length) throw new Error("empty skill tree");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const file of files) {
    const bytes = runGit(git, repo, ["cat-file", "blob", file.oid]);
    if (bytes.length !== file.size) throw new Error("skill blob size changed");
    const dest = join(dir, file.path);
    mkdirSync(dirname(dest), { mode: 0o700, recursive: true });
    writeFileSync(dest, bytes, { flag: "wx", mode: 0o400 });
    hashEntry(hash, file.path, bytes);
  }
  const digest = hash.digest("hex");
  if (digest !== bundleDigest(dir)) throw new Error("materialized bundle differs from pinned tree");
  return digest;
}

export function composeInstructions(dir: string, role: string, project: string | null) {
  if (!/^[a-z][a-z0-9-]*$/.test(role)) throw new Error("invalid skill name");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const skill = decoder.decode(readRegularFile(join(dir, role, "SKILL.md"), FILE_LIMIT));
  const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill);
  if (!header || !header[1]!.split(/\r?\n/).includes("name: " + role)) throw new Error("invalid skill frontmatter");
  const body = skill.slice(header[0].length).trim();
  const contract = decoder.decode(readRegularFile(join(dir, "_shared", "run-contract.md"), FILE_LIMIT)).trim();
  if (!body || !contract) throw new Error("empty skill or run contract");
  const text = `<factory_skill name="${role}">\n${body}\n</factory_skill>\n\n<factory_run_contract>\n${contract}\n</factory_run_contract>\n` + (project ? "\n" + project : "");
  if (Buffer.byteLength(text) > MAX_INSTRUCTIONS_BYTES) throw new Error("combined instructions exceed byte limit");
  return text;
}
