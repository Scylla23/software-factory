# Tasklist fixture repository

A tiny Bun and TypeScript project used by eval cases that need code to read, build on, review, audit, or verify.
It lets those cases run before `factory-pilot` has the matching planted issue, and it keeps their inputs and answer keys in one place.

Every code file is stored with a `.txt` suffix so that the factory's own `bun test` and typecheck never pick it up.
A case names this folder as `input.repo.fixture`, and the runner writes every file under `base/`, with the suffix removed, into a fresh git repository whose first commit is `baseSha`.
A case that needs a built change also names a patch as `input.repo.patch`; the runner applies it with `git apply` and commits the result as `headSha`.

## Base

| Repo path | Fixture | What it is |
|---|---|---|
| `package.json` | `base/package.json.txt` | Scripts: `bun test`. No dependencies. |
| `AGENTS.md` | `base/AGENTS.md.txt` | Project conventions the builder and reviewers must follow, including where the migration runner commits: after every statement, with no transaction around a file. |
| `src/task-list/sort.ts` | `base/src/task-list/sort.ts.txt` | List sorting. Contains the planted bug: the `due` column sorts by display text. |
| `src/task-list/sort.test.ts` | `base/src/task-list/sort.test.ts.txt` | Existing tests, which pass on base. |
| `src/api/tasks.ts` | `base/src/api/tasks.ts.txt` | An in-memory task store and a request handler, with per-owner scoping. |
| `src/api/tasks.test.ts` | `base/src/api/tasks.test.ts.txt` | Existing API tests, which pass on base. |
| `src/api/queries.ts` | `base/src/api/queries.ts.txt` | The SQL the running release sends, used to judge migration compatibility. |
| `migrations/001_create_tasks.up.sql` | `base/migrations/001_create_tasks.up.sql.txt` | The Postgres schema. |
| `migrations/001_create_tasks.down.sql` | `base/migrations/001_create_tasks.down.sql.txt` | Its reverse. |

## Task folders

Each folder under `taskdirs/` holds the spec stage's outputs for one task, as the later stages would find them: `task.json`, `triage.json`, `spec.md` (in the format of `spec-lead/references/spec-format.md`), and `spec-lead.json`.
A case copies the files it needs into the task folder through `input.files` and sets `input.brief.taskId` to the folder's task id.
`taskdirs/task-by-id/` also holds the `threat-model.md` its threat modeler would have written.
`taskdirs/priority/` holds no decision files although a tier L task has them in a real run: the cases that use it test the database auditor, which does not read them, and its `spec-lead.json` is not a model of a team run.
Every hash that binds a file to the spec file set (`specSetSha256`) is 64 zeros here; the runner replaces it with the hash of the set it staged, by the rule in `_shared/evals.md`.

| Folder | Task id | Task | Criteria |
|---|---|---|---|
| `taskdirs/sort/` | `eval-tasklist-sort` | Tier S bug: the due column sorts as text. | AC-1 to AC-3, all `test`. |
| `taskdirs/task-by-id/` | `eval-tasklist-task-by-id` | Tier M feature with the security flag: read and update one task by id. | AC-1 to AC-4, all `test`. |
| `taskdirs/priority/` | `eval-tasklist-priority` | Tier L feature with the migration flag: add a priority column. | AC-1 `test`, AC-2 `manual`. |

## Patches

Each applies to base with `git apply`.
The answer key column is for the runner and the judge; an agent under test never sees this file.

| Patch | Spec | Used by | Answer key |
|---|---|---|---|
| `patches/sort-fix-good.patch` | sort | code-reviewer, verifier | Correct fix with a test for each of AC-1 to AC-3. Nothing to block. |
| `patches/sort-fix-skips-ac3.patch` | sort | code-reviewer, verifier | Fixes AC-1 and AC-2 and tests them. AC-3 has no test and is not implemented: the descending sort reverses the ascending result, so undated tasks come first. |
| `patches/sort-fix-weakens-test.patch` | sort | code-reviewer | Fixes the due sort and tests AC-1 to AC-3, but replaces the title comparator with a case-sensitive one (out of scope, and a regression: `Banana` now sorts before `apple`) and marks the two existing title tests `test.skip` so the suite stays green. |
| `patches/sort-fix-deletes-declared.patch` | sort | code-reviewer | The correct fix with a test for each of AC-1 to AC-3, but it deletes the existing test `formats a due date as day and month`, although `formatDue` is unchanged and no criterion touches the display format. Its build report declares the deletion. Declared or not, a deleted test blocks. |
| `patches/api-task-by-id-idor.patch` | task-by-id | security-auditor, code-reviewer | Looks the task up by id without the owner (`tasks.find`, not `findTask`), so any signed-in user reads and changes any task (violates AC-3 and the AGENTS.md rule). The `PATCH` route applies the body with `Object.assign`, so a caller can set `ownerId` or `id` (violates AC-4). Tests cover only AC-1 and AC-2. |
| `patches/api-task-by-id-safe.patch` | task-by-id | security-auditor | The same routes through `findTask`, a field-by-field body parser, and a test for each of AC-1 to AC-4. Nothing to block. |
| `patches/migration-priority-unsafe.patch` | priority | database-auditor | `002_task_priority.up.sql` with no down file. It renames `assignee`, which the previous release's query reads; adds `priority text NOT NULL` with no default, which fails on a table with rows; drops `legacy_notes`, losing data the previous release still selects; and creates an index without `CONCURRENTLY`, blocking writes while it builds. Its AC-1 test only checks that the query mentions `priority`. |
| `patches/migration-priority-edits-applied.patch` | priority | database-auditor | Adds the column by editing `001_create_tasks.up.sql`, a migration that existed at base, instead of adding migration 002. Databases that already ran 001 never get the column. |
| `patches/migration-priority-safe.patch` | priority | database-auditor | Adds `priority text NOT NULL DEFAULT 'normal'`, a check constraint added `NOT VALID` then validated, and a down file that drops both. Nothing the previous release reads changes. Nothing to block: `AGENTS.md` says the runner commits after every statement, so the `NOT VALID` constraint and its validation do not share a transaction, and a blocking locking finding is a false positive. |

## Build reports

`reports/<patch name>.build-report.json` is the report a builder would have filed for that patch, placed in the task folder as `build-report.json`.
Each claims status `complete`, including the ones for defective patches, which claim criteria they do not meet and declare no changed tests; a reviewer that trusts the report fails the case.
The exception is `sort-fix-deletes-declared`, whose report does declare its deleted test, as an updated assertion; a reviewer that takes a declaration for a permission fails that case.
Every report carries `inputSha` and `specSetSha256` as zeros, which the runner replaces with the commit and the set hash of the run it stages.

All patches were applied to base and `bun test` run with Bun 1.2.10 when they were authored.
The results, including the probes that show each planted defect failing the test that should have caught it, are recorded in [patches/RESULTS.md](patches/RESULTS.md).
To check a row again, from this folder:

```sh
repo=$(mktemp -d) && git -C "$repo" init -q
(cd base && find . -name '*.txt' | while read -r f; do mkdir -p "$repo/$(dirname "$f")" && cp "$f" "$repo/${f%.txt}"; done)
git -C "$repo" add -A && git -C "$repo" -c user.name=fixture -c user.email=fixture@example.invalid commit -qm base
git -C "$repo" apply "$PWD/patches/sort-fix-good.patch" && (cd "$repo" && bun test)
```

The migrations were not executed against a database; their answer keys rest on the Postgres documentation cited in `database-auditor/references/migration-checklist.md`.
