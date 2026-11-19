/**
 * The local evidence store: one private directory per verification attempt, `<state root>/evidence/<attempt>`.
 * Evidence never leaves the machine; the PR only gets a text summary that points here (see src/github/summary.ts).
 *
 * Every file is created exclusively, never through a symlink, owner-only, and within a size limit, and the attempt's
 * directory is created exclusively too, so nothing in it predates the attempt and nothing is ever overwritten.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { assertPrivateDir } from "../dispatch/config";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE = /^[a-z0-9][a-z0-9-]{0,79}\.(png|json)$/;

/** Bound on one stored file. A 390x844 screenshot at scale 3 is a few MiB; anything far past that is not evidence. */
export const MAX_EVIDENCE_FILE_BYTES = 32 * 1024 * 1024;
/** Bound on everything one attempt stores. */
export const MAX_EVIDENCE_ATTEMPT_BYTES = 256 * 1024 * 1024;

export interface StoredFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface EvidenceStore {
  attemptId: string;
  dir: string;
  /** Copies a regular file (never a symlink) of at most `maxBytes` into the store as `name`. */
  putFile(name: string, source: string, maxBytes?: number): StoredFile;
  /** Writes `value` as pretty JSON. */
  putJson(name: string, value: unknown, maxBytes?: number): StoredFile;
}

/** Creates the attempt's evidence directory under `<state root>/evidence`, both private, the attempt's exclusively. */
export function openEvidenceStore(stateRoot: string, attemptId: string): EvidenceStore {
  if (!UUID.test(attemptId)) throw new Error(`attempt id must be a lowercase UUID: ${attemptId}`);
  const root = join(stateRoot, "evidence");
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const real = assertPrivateDir(root, stateRoot);
  const dir = join(real, attemptId);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`evidence for attempt ${attemptId} already exists at ${dir}; it is left untouched`);
    throw err;
  }
  let total = 0;

  const create = (name: string): { path: string; fd: number } => {
    if (!FILE.test(name)) throw new Error(`evidence file name must match ${FILE}: ${JSON.stringify(name)}`);
    const path = join(dir, name);
    return { path, fd: openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) };
  };
  const account = (bytes: number, maxBytes: number, what: string) => {
    if (bytes > maxBytes) throw new Error(`${what} is ${bytes} bytes, over the ${maxBytes}-byte limit`);
    if (total + bytes > MAX_EVIDENCE_ATTEMPT_BYTES) throw new Error(`${what} would take attempt ${attemptId} past ${MAX_EVIDENCE_ATTEMPT_BYTES} bytes`);
  };

  return {
    attemptId,
    dir,
    putFile(name, source, maxBytes = MAX_EVIDENCE_FILE_BYTES) {
      const st = lstatSync(source);
      if (!st.isFile()) throw new Error(`evidence source ${source} is not a regular file`);
      const src = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const size = fstatSync(src).size;
        account(size, maxBytes, source);
        const out = create(name);
        const hash = createHash("sha256");
        let copied = 0;
        try {
          // Copies exactly the size checked above: a source that grows meanwhile cannot take the store past its limits.
          const buf = Buffer.alloc(1024 * 1024);
          while (copied < size) {
            const n = readSync(src, buf, 0, Math.min(buf.length, size - copied), null);
            if (n === 0) throw new Error(`${source} shrank while it was copied`);
            writeSync(out.fd, buf, 0, n);
            hash.update(buf.subarray(0, n));
            copied += n;
          }
        } catch (err) {
          // A partial copy is not evidence.
          closeSync(out.fd);
          unlinkSync(out.path);
          throw err;
        }
        closeSync(out.fd);
        total += copied;
        return { path: out.path, bytes: copied, sha256: hash.digest("hex") };
      } finally {
        closeSync(src);
      }
    },
    putJson(name, value, maxBytes = MAX_EVIDENCE_FILE_BYTES) {
      const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      account(data.length, maxBytes, name);
      const out = create(name);
      try {
        writeSync(out.fd, data);
      } finally {
        closeSync(out.fd);
      }
      total += data.length;
      return { path: out.path, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    },
  };
}
