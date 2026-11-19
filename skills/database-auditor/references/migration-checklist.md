# Migration checklist

Engine facts and safe forms for the database auditor.
The approved databases in the infra catalog are Postgres (`neon`) and SQLite or libSQL (`turso`), so those two are covered.
For any other engine, say in the verdict that it is outside this checklist and judge the statements conservatively.

"Blocks" below means for the duration of the statement, which on a large table can be minutes.
Table size is rarely known to you; assume a table that holds user data is large unless the spec says otherwise, and state the assumption.

## Expand and contract

Old and new code run side by side during a deploy, and a rollback puts old code on the new schema.
A schema change is therefore safe only when the code at `baseSha` still works after the migration has run.

| Change | Unsafe form | Safe sequence |
|---|---|---|
| Rename a column or table | `RENAME` in one step | Add the new column, write both, backfill, switch reads, and drop the old one in a later task. |
| Remove a column or table | `DROP` while any released code reads or writes it | Stop using it in code first; drop in a later task. |
| Add a required column | `NOT NULL` with no default | Add it with a default, or nullable, then backfill, then enforce. |
| Change a type | `ALTER COLUMN TYPE` in place | Add a new column of the new type, backfill, switch, and drop later. |
| Tighten a constraint | Add it validated in one step | Add it unenforced or not valid, fix the data, then validate. |
| Split or merge tables | Move data and switch code in one release | Dual-write behind the old shape, backfill, switch reads, and remove later. |

The contract half (the drop, the rename's cleanup) belongs in a later task, after a release in which no code uses the old shape.
A migration that expands and contracts in one task is blocking unless the spec states that no deployed code or data exists yet, as in a new project.

## Reversibility

- Every up migration has a down migration in the project's convention, and the down undoes exactly what the up did, in reverse order.
- A down that cannot restore data (after a drop, a narrowing, or a lossy backfill) is not a real reverse.
  Such a migration must be declared irreversible in the spec, with the reason and the recovery path.
- A migration file that existed at `baseSha` must not be edited: databases that already ran it will never see the change, and environments drift apart.
  Schema changes always arrive as a new migration.
- Migration numbers or timestamps are unique and later than every existing one.
- Schema changes and large data backfills are separate migrations, so one can be retried without the other.

## Data loss

Statements that destroy or silently alter data:

- `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`.
- `DELETE` or `UPDATE` with no `WHERE`, or with a predicate wider than the spec's intent.
- A type change that narrows: text to a shorter length, a wider integer to a narrower one, timestamp with zone to without, numeric precision reduced.
- A backfill that overwrites existing values, or that maps several old values to one.
- A new `ON DELETE CASCADE`, which turns a later delete into a cascade.
- A new unique constraint or `NOT NULL` whose "fix" for violating rows is to delete them.

Each needs an explicit statement in the spec that the loss is intended, and a criterion or plan step that covers existing rows.

## Postgres

Locks:

- Most `ALTER TABLE` forms take an `ACCESS EXCLUSIVE` lock, which blocks reads and writes.
  The statement also waits in the lock queue behind long transactions, and everything queued behind it waits too, so a migration should set a `lock_timeout`.
- `ADD COLUMN` with no default, or with a constant default, does not rewrite the table (version 11 and later).
  A volatile default such as `clock_timestamp()` or `gen_random_uuid()` rewrites the whole table under the lock.
- `ADD COLUMN ... NOT NULL` with no default fails outright when the table has rows.
- `ALTER COLUMN ... SET NOT NULL` scans the whole table under the lock, unless a valid `CHECK (col IS NOT NULL)` constraint already proves it (version 12 and later).
- `ALTER COLUMN ... TYPE` rewrites the table and its indexes, except for binary-compatible changes such as `varchar(n)` to `text` or a longer `varchar`.
- `ADD CONSTRAINT ... CHECK` scans the table under `ACCESS EXCLUSIVE`, and `ADD CONSTRAINT ... FOREIGN KEY` scans it under `SHARE ROW EXCLUSIVE` on both tables, which blocks writes.
  Adding them `NOT VALID` skips the scan, and a separate `VALIDATE CONSTRAINT` then scans under a `SHARE UPDATE EXCLUSIVE` lock, which allows reads and writes.
- `ADD CONSTRAINT ... UNIQUE` and `ADD PRIMARY KEY` build an index under the lock.
  Build the index first with `CREATE UNIQUE INDEX CONCURRENTLY`, then attach it with `ADD CONSTRAINT ... USING INDEX`.
- `DROP COLUMN` is fast because it only marks the column dropped, and for the same reason its data is gone for practical purposes.
- `RENAME` is a metadata change and is instant; its danger is to running code, not to the database.

Indexes:

- `CREATE INDEX` blocks writes to the table until the build finishes.
  `CREATE INDEX CONCURRENTLY` does not, but it cannot run inside a transaction block, takes longer, and on failure leaves an invalid index that must be dropped.
  Check how the project's migration runner wraps statements before requiring it.
- `DROP INDEX` has a `CONCURRENTLY` form with the same transaction restriction.
- A foreign key column has no index unless one is created; deletes and updates on the referenced table then scan the referencing table.
- A unique index fails to build when duplicates exist; the migration must deal with existing duplicates first.

Transactions:

- Statements in one transaction hold their locks until it commits, so a fast `ALTER` followed by a slow backfill or validation keeps the strongest lock for the whole run.
- A backfill over a large table should run in batches outside the schema transaction.
- A new enum value added with `ALTER TYPE ... ADD VALUE` cannot be used until the transaction that added it commits, and enum values cannot be removed.

## SQLite and libSQL

- `ALTER TABLE` supports `RENAME TO`, `RENAME COLUMN`, `ADD COLUMN`, and `DROP COLUMN`.
  SQLite 3.53.0 (2026-04-09) added `ALTER COLUMN ... SET NOT NULL` and `DROP NOT NULL`, and adding or dropping a named `CHECK` constraint; a migration that uses them fails on an older SQLite or on a libSQL build that predates them, so check the version the project runs.
  Anything else (changing a type, a default, a primary key, or a foreign key) needs the documented table rebuild: create the new table, copy the rows, drop the old table, and rename the new one, inside a transaction.
- `ADD COLUMN` cannot add a `PRIMARY KEY` or `UNIQUE` column, a `NOT NULL` column needs a default other than `NULL`, and the default cannot be `CURRENT_TIMESTAMP` or another non-constant expression.
- `DROP COLUMN` fails when the column is a primary key, is unique, is indexed, or is referenced by a constraint, view, trigger, or foreign key.
- A table rebuild must preserve indexes, triggers, and views that refer to the table, and must handle foreign key enforcement as the documented procedure describes; a rebuild that omits them silently loses them.
- There is one writer at a time, so a long migration transaction blocks every other write.
- Column types are affinities, not enforced types, unless the table is `STRICT`; a "type change" may change nothing about stored values.

## Queries and the ORM

- When the project keeps a schema file or ORM model beside its migrations, the diff changes both, and they describe the same shape.
- Every query the diff adds or changes filters, joins, and sorts on indexed columns, or the spec says the table is small.
- A new query inside a loop over rows (one query per row) is an index and load problem even when each query is fast.
- Queries built with string concatenation of input are a security finding; mention it and leave the detail to the security auditor.

## References

For people; agents have no network.
All were live on 2026-11-19.

- Postgres explicit locking: https://www.postgresql.org/docs/current/explicit-locking.html
- Postgres `ALTER TABLE`: https://www.postgresql.org/docs/current/sql-altertable.html
- Postgres `CREATE INDEX`: https://www.postgresql.org/docs/current/sql-createindex.html
- SQLite `ALTER TABLE`: https://www.sqlite.org/lang_altertable.html
- Strong Migrations, a catalog of unsafe operations and their safe forms: https://github.com/ankane/strong_migrations
- Evolutionary database design: https://martinfowler.com/articles/evodb.html
- Parallel change (expand and contract): https://martinfowler.com/bliki/ParallelChange.html
