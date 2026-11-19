# Task list sorts the Due column as text

Tier: S - Builder: Sol 6.2 - Code reviewer: Opus 5.5
Task: github Scylla23/factory-pilot#101 revision 1
Flags: none

## Problem

Sorting the task list by due date orders rows by the date's display text, so 10 Nov appears before 2 Nov.
The owner expects chronological order.
Tasks already carry ISO dates; only the list's `due` comparator is wrong.

## Non-goals

- No change to the API or to how dates are stored.
- No new sort options or multi-column sorting.
- No change to the date display format or to title sorting.

## Acceptance criteria

### AC-1: Reproduction - ascending sort is chronological

- Tag: test
- Fixture: three tasks due 2026-11-20, 2026-11-10, and 2026-11-02, in that order.
- Action: call `sortTasks` with column `due` and direction `asc`.
- Expected: the due dates come back as 2026-11-02, 2026-11-10, 2026-11-20; on base the test fails because 2026-11-10 sorts first.

### AC-2: Descending sort is reverse chronological

- Tag: test
- Fixture: the same three tasks.
- Action: call `sortTasks` with column `due` and direction `desc`.
- Expected: the due dates come back as 2026-11-20, 2026-11-10, 2026-11-02.

### AC-3: Tasks without a due date sort last

- Tag: test
- Fixture: the same three tasks plus one with `due: null`.
- Action: call `sortTasks` with column `due`, direction `asc`, then direction `desc`.
- Expected: the task with no due date is the last element in both results.

## Design choices

- Compare parsed timestamps rather than adding a date library; `Date.parse` on ISO strings is sufficient and the project has no dependencies.
- Keep the fix inside the list's sort module.

## Reused files

- `src/task-list/sort.ts`: `sortTasks` and its `comparators` map; only the `due` ordering changes.
- `src/task-list/sort.test.ts`: the existing `task(...)` helper and test style.

## Implementation plan

1. Add the failing reproduction for AC-1 to the sort tests, run it, and confirm it fails because 2026-11-10 sorts first (files: `src/task-list/sort.test.ts`; serves AC-1).
2. Order the `due` column by timestamp, with missing dates last in both directions (files: `src/task-list/sort.ts`; serves AC-1, AC-2, AC-3).
3. Add tests for descending order and missing dates (files: `src/task-list/sort.test.ts`; serves AC-2, AC-3).

## Risks

- Reversing an ascending result would move undated tasks to the front when descending, so AC-3 asserts both directions.

## Open questions

None.
