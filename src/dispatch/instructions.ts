import { realpathSync } from "node:fs";
import { isUnder } from "./config";
import { runGit } from "./git";

/** Instruction files a project may have, as repo-relative paths, in the order they are passed. */
export const PROJECT_INSTRUCTION_PATHS = ["AGENTS.md", "CLAUDE.md"] as const;

/** Bound on the combined instructions; Codex receives them in argv, which macOS caps at 1 MiB with the env. */
export const MAX_INSTRUCTIONS_BYTES = 256 * 1024;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Where a run's project instructions come from: tracked blobs at an approved base commit of a factory-controlled
 * repository, never a working tree, so nothing an agent wrote to disk (in this worktree or a sibling) can reach them.
 */
export interface InstructionSource {
  /** A checkout of the project outside every agent-writable root; only its object database is read. */
  repo: string;
  /** Full commit id the owner approved as the base. */
  baseSha: string;
  /** Repo-relative paths, usually PROJECT_INSTRUCTION_PATHS; a path the commit does not have is skipped. */
  paths: readonly string[];
}

interface Entry {
  path: string;
  oid: string;
}

/**
 * The text both harnesses receive, byte for byte, or null when the commit has none of the paths.
 * Every listed path that exists must be a regular file (mode 100644 or 100755): a symlink or any other entry refuses
 * the run. A path whose blob is already included (a CLAUDE.md copy of AGENTS.md) is included once.
 * Sizes are checked against MAX_INSTRUCTIONS_BYTES before any blob is read.
 */
export function buildProjectInstructions(source: InstructionSource, gitPath: string, agentWritableRoots: readonly string[]): string | null {
  if (!source.repo.startsWith("/")) throw new Error(`instruction repo must be absolute: ${source.repo}`);
  const repo = realpathSync(source.repo);
  for (const root of agentWritableRoots) {
    if (isUnder(repo, root)) throw new Error(`instruction repo ${repo} is under agent-writable ${root}`);
  }
  if (!FULL_SHA.test(source.baseSha)) throw new Error(`base commit must be a full lowercase commit id: ${JSON.stringify(source.baseSha)}`);
  const git = (args: string[]) => runGit(gitPath, repo, args);
  let resolved = "";
  try {
    resolved = git(["rev-parse", "--verify", "--quiet", `${source.baseSha}^{commit}`]).toString("utf8").trim();
  } catch {
    // not a commit in this repo; refused below
  }
  if (resolved !== source.baseSha) throw new Error(`base commit ${source.baseSha} is not a commit in ${repo}`);

  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const path of source.paths) {
    assertRepoPath(path);
    const entry = treeEntry(git, source.baseSha, path);
    if (!entry || seen.has(entry.oid)) continue;
    seen.add(entry.oid);
    entries.push(entry);
  }

  const sizes = entries.map((e) => {
    const size = Number(git(["cat-file", "-s", e.oid]).toString("utf8").trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`git reported no size for ${e.path}`);
    return size;
  });
  if (sizes.reduce((a, b) => a + b, 0) > MAX_INSTRUCTIONS_BYTES) throw new Error(`project instructions exceed ${MAX_INSTRUCTIONS_BYTES} bytes`);

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const sections = entries.map((e, i) => {
    const raw = git(["cat-file", "blob", e.oid]);
    if (raw.length !== sizes[i]) throw new Error(`blob for ${e.path} changed size while reading`);
    let text: string;
    try {
      text = decoder.decode(raw);
    } catch {
      throw new Error(`instruction file is not valid UTF-8: ${e.path}`);
    }
    return `<file name="${e.path}">\n${text.endsWith("\n") ? text : `${text}\n`}</file>`;
  });
  if (sections.length === 0) return null;
  return `<project_instructions>\nThe project's own instruction files, passed by the factory. Follow them.\n\n${sections.join("\n\n")}\n</project_instructions>\n`;
}

/** Plain segments only, so a path cannot climb out, be read as an option, or carry pathspec magic. */
function assertRepoPath(path: string): void {
  const ok = path.split("/").every((s) => PATH_SEGMENT.test(s) && s !== "." && s !== "..");
  if (!ok) throw new Error(`instruction path must be repo-relative with plain segments: ${JSON.stringify(path)}`);
}

/** The commit's own tree entry for `path`, or null when it has none; refuses anything but a regular file. */
function treeEntry(git: (args: string[]) => Buffer, sha: string, path: string): Entry | null {
  const out = git(["ls-tree", "-z", "--full-tree", sha, "--", path]).toString("utf8");
  const records = out.split("\0").filter(Boolean);
  if (records.length === 0) return null;
  const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(records[0]!);
  if (records.length !== 1 || !match || match[4] !== path) throw new Error(`unexpected git ls-tree output for ${path}`);
  const [, mode, type, oid] = match;
  if (mode === "120000") throw new Error(`instruction file ${path} is a symlink at ${sha}`);
  if (type !== "blob" || (mode !== "100644" && mode !== "100755")) throw new Error(`instruction file ${path} is not a regular file at ${sha} (mode ${mode})`);
  return { path, oid: oid! };
}
