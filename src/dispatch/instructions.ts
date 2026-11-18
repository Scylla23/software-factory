import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { isUnder } from "./config";

/** Instruction file names a project may have, in the order they are passed. */
export const PROJECT_INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Bound on the combined instructions; Codex receives them in argv, which macOS caps at 1 MiB with the env. */
export const MAX_INSTRUCTIONS_BYTES = 256 * 1024;

/** The instruction files present in a factory-controlled checkout of the project, such as its base branch. */
export function projectInstructionFiles(checkout: string): string[] {
  return PROJECT_INSTRUCTION_NAMES.map((name) => join(checkout, name)).filter((p) => existsSync(p));
}

/**
 * The text both harnesses receive, byte for byte, or null when there are no files.
 * Files are refused when they live where an agent can write (the worktree or a temp root), because a later run in the
 * same worktree would otherwise take its instructions from what an earlier agent wrote.
 * A file that resolves to one already included (a CLAUDE.md symlinked to AGENTS.md) is included once.
 */
export function buildProjectInstructions(files: readonly string[], agentWritableRoots: readonly string[]): string | null {
  const seen = new Set<string>();
  const sections: string[] = [];
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const file of files) {
    if (!file.startsWith("/")) throw new Error(`instruction file must be absolute: ${file}`);
    const real = realpathSync(file);
    for (const root of agentWritableRoots) {
      if (isUnder(real, root)) throw new Error(`instruction file ${real} is under agent-writable ${root}`);
    }
    if (seen.has(real)) continue;
    seen.add(real);
    if (!statSync(real).isFile()) throw new Error(`instruction file is not a regular file: ${real}`);
    const raw = readFileSync(real);
    bytes += raw.length;
    if (bytes > MAX_INSTRUCTIONS_BYTES) throw new Error(`project instructions exceed ${MAX_INSTRUCTIONS_BYTES} bytes`);
    let text: string;
    try {
      text = decoder.decode(raw);
    } catch {
      throw new Error(`instruction file is not valid UTF-8: ${real}`);
    }
    sections.push(`<file name="${basename(file)}">\n${text.endsWith("\n") ? text : `${text}\n`}</file>`);
  }
  if (sections.length === 0) return null;
  return `<project_instructions>\nThe project's own instruction files, passed by the factory. Follow them.\n\n${sections.join("\n\n")}\n</project_instructions>\n`;
}
