# Add a priority to tasks

Tier: L - Builder: Opus 5.5 - Code reviewer: GPT-6.2-Astra
Task: github Scylla23/factory-pilot#103 revision 1
Flags: migration

## Problem

Tasks have no priority, so the owner cannot tell urgent tasks from the rest.
Each task needs a priority of `low`, `normal`, or `high`, with existing tasks counted as `normal`.

## Non-goals

- No sorting or filtering by priority in this task.
- No rename or removal of any existing column.
- No user interface for setting the priority; that is a later task.

## Acceptance criteria

### AC-1: The list query returns the priority

- Tag: test
- Fixture: the `LIST_TASKS` query text.
- Action: read the query's selected columns.
- Expected: the query selects `priority` and still selects every column it selected on base.

### AC-2: The migration is reversible and safe to run under the previous release

- Tag: manual
- Fixture: a Postgres database at migration 001 holding at least one task row, with the previous release's code still running.
- Action: Owner: apply `002_task_priority.up.sql`, run the previous release's list query, then apply `002_task_priority.down.sql`.
- Expected: the up migration succeeds with rows present, existing rows have priority `normal`, the previous release's query still succeeds, and the down migration restores the 001 schema.

## Design choices

- Add the column with a constant default so existing rows get `normal` without a table rewrite.
- Enforce the three values with a check constraint added as `NOT VALID` and validated in a second statement, so the long validation does not hold the strongest lock.
- Expand only: nothing the previous release reads is renamed or dropped.

## Reused files

- `migrations/001_create_tasks.up.sql`: the `tasks` table the new column is added to.
- `src/api/queries.ts`: the `LIST_TASKS` query.

## Implementation plan

1. Add `migrations/002_task_priority.up.sql` and its `.down.sql` (files: `migrations/002_task_priority.up.sql`, `migrations/002_task_priority.down.sql`; serves AC-2).
2. Add `priority` to the `LIST_TASKS` column list (files: `src/api/queries.ts`; serves AC-1).

## Risks

- A `NOT NULL` column with no default fails on a table with rows; the default is part of the design.
- The previous release keeps running during the deploy, so the migration must not remove or rename anything it reads.

## Open questions

None.
