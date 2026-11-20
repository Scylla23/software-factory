import type { Database } from "bun:sqlite";
import { outputDigest } from "../dispatch/output";

export function migrateSkillStore(db: Database) {
  db.exec(`
    CREATE TABLE skill_tasks (
      task INTEGER PRIMARY KEY REFERENCES tasks(id), factory_commit TEXT NOT NULL);
    CREATE TABLE skill_collections (
      attempt TEXT PRIMARY KEY REFERENCES attempts(id), role TEXT NOT NULL,
      round INTEGER NOT NULL, bundle_hash TEXT NOT NULL, base TEXT NOT NULL, head TEXT NOT NULL);
    CREATE TABLE skill_files (
      attempt TEXT NOT NULL REFERENCES skill_collections(attempt), path TEXT NOT NULL,
      role TEXT NOT NULL, session TEXT NOT NULL, sha256 TEXT NOT NULL, content BLOB NOT NULL,
      PRIMARY KEY(attempt,path));
    PRAGMA user_version=4;
  `);
}

export interface SkillFile {
  path: string; role: string; session: string; sha256: string; base64: string;
}
export interface Collection {
  attempt: string; role: string; round: number; bundleHash: string; base: string; head: string; files: SkillFile[];
}

export function pinFactoryCommit(db: Database, task: number, commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("invalid skill commit");
  db.run("INSERT OR IGNORE INTO skill_tasks VALUES(?,?)", [task, commit]);
  return db.query<{ factory_commit: string }, [number]>("SELECT factory_commit FROM skill_tasks WHERE task=?").get(task)!.factory_commit;
}

/** Accept the whole validated set atomically, including the bytes and the principals who submitted them. */
export function archiveCollection(db: Database, task: number, c: Collection) {
  db.transaction(() => {
    const owner = db.query<{task: number}, [string]>("SELECT task FROM attempts WHERE id=?").get(c.attempt);
    if (owner?.task !== task || !c.files.length) throw new Error("invalid skill collection identity");
    const previous = readCollection(db, c.attempt);
    if (previous) {
      const prior = new Map(previous.files.map(f => [f.path, f]));
      if (previous.role !== c.role || previous.round !== c.round || previous.bundleHash !== c.bundleHash ||
          previous.base !== c.base || previous.head !== c.head || previous.files.length !== c.files.length ||
          new Set(c.files.map(f => f.path)).size !== c.files.length || c.files.some(f => {
            const saved = prior.get(f.path);
            return !saved || saved.role !== f.role || saved.session !== f.session || saved.sha256 !== f.sha256 || saved.base64 !== f.base64;
          })) throw new Error("immutable skill collection changed");
      return;
    }
    db.run("INSERT INTO skill_collections VALUES(?,?,?,?,?,?)", [c.attempt, c.role, c.round, c.bundleHash, c.base, c.head]);
    for (const f of c.files) {
      const bytes = Buffer.from(f.base64, "base64");
      if (bytes.toString("base64") !== f.base64 || outputDigest(bytes) !== f.sha256 || !f.session)
        throw new Error("invalid archived skill bytes or author");
      db.run("INSERT INTO skill_files VALUES(?,?,?,?,?,?)", [c.attempt, f.path, f.role, f.session, f.sha256, bytes]);
    }
  }).immediate();
}

export function readCollection(db: Database, attempt: string): Collection | null {
  const row = db.query<Omit<Collection, "files">, [string]>(
    "SELECT attempt,role,round,bundle_hash AS bundleHash,base,head FROM skill_collections WHERE attempt=?",
  ).get(attempt);
  if (!row) return null;
  const files = db.query<Omit<SkillFile, "base64"> & {content: Uint8Array}, [string]>(
    "SELECT path,role,session,sha256,content FROM skill_files WHERE attempt=? ORDER BY path",).all(attempt);
  return { ...row, files: files.map(({ content, ...f }) => {
    const bytes = Buffer.from(content);
    if (outputDigest(bytes) !== f.sha256) throw new Error("archived skill bytes changed");
    return { ...f, base64: bytes.toString("base64") };
  }) };
}

/** Only a dispatch whose stage effect committed is eligible as an input to a later run. */
export function acceptedCollections(db: Database, task: number) {
  return db.query<{ attempt: string }, [number]>(
    `SELECT c.attempt FROM skill_collections c JOIN attempts a ON a.id=c.attempt
     WHERE a.task=? AND a.result IS NOT NULL ORDER BY a.visit, a.rowid`,
  ).all(task).map(row => readCollection(db, row.attempt)!);
}
