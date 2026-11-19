import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AttemptDirectories } from "./attempt";
import { readRegularFile } from "./regular-file";

/** Factory-owned record made from the complete successful native submission. */
export interface NativeWrite {
  attemptId: string;
  taskId: string;
  sessionId: string;
  role: string;
  path: string;
  sha256: string;
}

export interface OutputAuthor {
  sessionId: string;
  role: string;
}

export class OutputIntegrityError extends Error {}

export function outputDigest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Only called after the supervisor has reaped the run. No caller sees partial results. */
export function collectOutputs(
  attempt: Pick<AttemptDirectories, "outDir" | "outputIdentity">,
  identity: { taskId: string; attemptId: string },
  expected: ReadonlyMap<string, OutputAuthor>,
  writes: readonly NativeWrite[],
) {
  const { outDir, outputIdentity } = attempt;
  function checkDirectory() {
    const current = lstatSync(outDir, { bigint: true });
    if (!current.isDirectory() || current.dev !== outputIdentity.dev || current.ino !== outputIdentity.ino)
      throw new OutputIntegrityError("output directory replaced");
  }
  checkDirectory();
  const directories = new Set<string>();
  for (const path of expected.keys()) {
    const parts = path.split("/");
    if (!parts.every(p => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p))) throw new Error("invalid expected output path");
    for (let i = 1; i < parts.length; ++i) directories.add(parts.slice(0, i).join("/"));
  }
  function inventory(parent: string) {
    for (const entry of readdirSync(join(outDir, parent), { withFileTypes: true })) {
      const path = join(parent, entry.name);
      if (entry.isDirectory() && directories.has(path)) inventory(path);
      else if (!entry.isFile() || !expected.has(path)) throw new OutputIntegrityError(`unexpected output entry ${path}`);
    }
  }
  inventory("");
  const captured = new Map<string, Buffer>();
  for (const [path, author] of expected) {
    const write = writes.findLast(record => record.path === path);
    if (!write || write.taskId !== identity.taskId || write.attemptId !== identity.attemptId ||
        write.role !== author.role || !author.sessionId || write.sessionId !== author.sessionId)
      throw new OutputIntegrityError(`missing authenticated final write by ${author.role} for ${path}`);
    const bytes = readRegularFile(join(outDir, path), 1024 * 1024);
    if (outputDigest(bytes) !== write.sha256)
      throw new OutputIntegrityError(`output bytes changed after authenticated final write: ${path}`);
    captured.set(path, bytes);
  }
  checkDirectory();
  return captured;
}
