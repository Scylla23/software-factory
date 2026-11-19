import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_EVIDENCE_ATTEMPT_BYTES, openEvidenceStore } from "../src/verify/store";

let state: string;
let src: string;
beforeEach(() => {
  state = realpathSync(mkdtempSync(join(tmpdir(), "verify-store-")));
  src = join(state, "src");
  mkdirSync(src);
});
afterEach(() => rmSync(state, { recursive: true, force: true }));

const id = () => crypto.randomUUID();

describe("evidence store", () => {
  test("one private directory per attempt under <state root>/evidence, files owner-only, with their hashes", () => {
    const s = openEvidenceStore(state, id());
    expect(s.dir).toBe(join(state, "evidence", s.attemptId));
    expect(statSync(join(state, "evidence")).mode & 0o777).toBe(0o700);
    expect(statSync(s.dir).mode & 0o777).toBe(0o700);
    writeFileSync(join(src, "a.png"), "png-bytes");
    const f = s.putFile("before-desktop.png", join(src, "a.png"));
    expect(f).toEqual({ path: join(s.dir, "before-desktop.png"), bytes: 9, sha256: new Bun.CryptoHasher("sha256").update("png-bytes").digest("hex") });
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    const j = s.putJson("records.json", { a: 1 });
    expect(JSON.parse(readFileSync(j.path, "utf8"))).toEqual({ a: 1 });
    expect(statSync(j.path).mode & 0o777).toBe(0o600);
  });

  test("an attempt's directory is never reused, and a file is never overwritten", () => {
    const attempt = id();
    const s = openEvidenceStore(state, attempt);
    expect(() => openEvidenceStore(state, attempt)).toThrow("already exists");
    s.putJson("records.json", {});
    expect(() => s.putJson("records.json", {})).toThrow("EEXIST");
  });

  test("never writes through a symlink and never copies one", () => {
    const s = openEvidenceStore(state, id());
    const outside = join(state, "outside.txt");
    symlinkSync(outside, join(s.dir, "planted.json"));
    expect(() => s.putJson("planted.json", {})).toThrow();
    expect(existsSync(outside)).toBe(false);
    writeFileSync(join(src, "real.png"), "x");
    symlinkSync(join(src, "real.png"), join(src, "link.png"));
    expect(() => s.putFile("l.png", join(src, "link.png"))).toThrow("not a regular file");
  });

  test("names are plain, and the evidence root must be private", () => {
    const s = openEvidenceStore(state, id());
    expect(() => s.putJson("../x.json", {})).toThrow("evidence file name");
    expect(() => s.putJson("x.txt", {})).toThrow("evidence file name");
    expect(() => openEvidenceStore(state, "not-a-uuid")).toThrow("UUID");
    chmodSync(join(state, "evidence"), 0o755);
    expect(() => openEvidenceStore(state, id())).toThrow("accessible to group or others");
  });

  test("size limits hold per file and per attempt, and a refused copy leaves nothing behind", () => {
    const s = openEvidenceStore(state, id());
    writeFileSync(join(src, "big.png"), Buffer.alloc(2_000));
    expect(() => s.putFile("big.png", join(src, "big.png"), 1_000)).toThrow("over the 1000-byte limit");
    expect(() => s.putJson("big.json", "x".repeat(2_000), 1_000)).toThrow("over the 1000-byte limit");
    const huge = join(src, "huge.png");
    const fd = openSync(huge, "w");
    ftruncateSync(fd, MAX_EVIDENCE_ATTEMPT_BYTES + 1); // sparse
    closeSync(fd);
    expect(() => s.putFile("huge.png", huge, MAX_EVIDENCE_ATTEMPT_BYTES + 10)).toThrow(`past ${MAX_EVIDENCE_ATTEMPT_BYTES} bytes`);
    expect(readdirSync(s.dir)).toEqual([]);
  });
});
