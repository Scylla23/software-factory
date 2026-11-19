# Spec format

One Markdown file, `spec.md`, per task.
The factory parses the header block and the acceptance criteria, and the spec reviewer checks the rest against this layout, so keep the headings and line formats exact.

## Layout

```markdown
# <Task title in your own words>

Tier: <S|M|L> - Builder: <name> - Code reviewer: <name>
Task: <source> <externalId> revision <n>
Flags: <comma-separated subset of security, migration, new-project, or none>

## Problem

## Non-goals

## Acceptance criteria

### AC-1: <short name>

- Tag: <test|browser|computer-use|manual>
- Fixture: <starting state>
- Action: <one concrete action>
- Expected: <observable result>

## Design choices

## Reused files

- `<repo-relative path>`: <what is reused>

## Implementation plan

1. <step> (files: `<path>`, `<path>`; serves AC-1)

## Risks

## Open questions

- [non-blocking] <question> Assumed: <assumption>.
```

Rules the parser relies on:

- The line after the title's blank line is the header line, with ` - ` (space, hyphen, space) between its three parts.
- Sections appear once, in this order, at heading level 2.
- Each criterion is a level 3 heading `AC-<n>: <name>` followed by its bullet lines, each starting with the exact label.
- A `browser` criterion adds `- Route: <path starting with />` after the Tag line.
- Each field is one physical line, because the parser reads a field to the end of its line; join two clauses with a semicolon instead of starting a second sentence.
- A section with nothing to say contains the single line `None.`, so its absence is never mistaken for an oversight.
- Design choices may contain level 3 subsections; when conflicts were resolved, one is named `Conflicts resolved`.

## Worked example (tier S bug)

```markdown
# Task list sorts the Due column as text

Tier: S - Builder: Sol 6.2 - Code reviewer: Opus 5.5
Task: github Scylla23/factory-pilot#101 revision 1
Flags: none

## Problem

Clicking the Due column header on the task list orders rows by the date's text, so 10 Nov appears before 2 Nov.
The owner expects chronological order.
The API already returns ISO dates; only the list's comparator is wrong.

## Non-goals

- No change to the API or to how dates are stored.
- No new sort options or multi-column sorting.
- No change to the date display format.

## Acceptance criteria

### AC-1: Reproduction - ascending sort is chronological

- Tag: test
- Fixture: three tasks due 2026-11-02, 2026-11-10, and 2026-11-20, inserted newest first.
- Action: sort the list by due date, ascending.
- Expected: the order is 2026-11-02, 2026-11-10, 2026-11-20; on base the test fails because 2026-11-10 sorts first.

### AC-2: Descending sort is reverse chronological

- Tag: test
- Fixture: the same three tasks.
- Action: sort the list by due date, descending.
- Expected: the order is 2026-11-20, 2026-11-10, 2026-11-02.

### AC-3: Tasks without a due date sort last

- Tag: test
- Fixture: the same three tasks plus one with no due date.
- Action: sort the list by due date, ascending, then descending.
- Expected: the task with no due date is last in both orders.

### AC-4: The sorted list renders in order

- Tag: browser
- Route: /tasks?sort=due&dir=asc
- Fixture: the `seeded-tasks` project fixture.
- Action: load the route.
- Expected: the first three rows show due dates 2 Nov, 10 Nov, 20 Nov, top to bottom, at both viewports.

## Design choices

- Compare parsed timestamps in the existing comparator rather than adding a date library; `Date.parse` on the API's ISO strings is sufficient and the project has no date dependency.
- Keep the sort in the list module; the API's order is unchanged.

## Reused files

- `src/ui/task-list/sort.ts`: the `compareBy` helper and its column map; only the `due` comparator changes.
- `src/ui/task-list/sort.test.ts`: the existing table-driven test style for comparators.

## Implementation plan

1. Add the failing reproduction for AC-1 to the comparator tests, run it, and confirm it fails for the stated reason (files: `src/ui/task-list/sort.test.ts`; serves AC-1).
2. Change the `due` comparator to compare timestamps, with missing dates last in both directions (files: `src/ui/task-list/sort.ts`; serves AC-1, AC-2, AC-3).
3. Add tests for descending order and missing dates (files: `src/ui/task-list/sort.test.ts`; serves AC-2, AC-3).
4. Confirm the list route honors `sort` and `dir` from the URL with the seeded fixture (files: none expected; serves AC-4).

## Risks

- A date string the API could return in a non-ISO form would parse inconsistently; the API schema guarantees ISO, and AC-1 to AC-3 use ISO fixtures.

## Open questions

None.
```

## Notes on writing criteria

- Name the fixture precisely enough that two people would build the same starting state.
- Put the bug's wrong result in AC-1's Expected line, as in the example, so the reproduction's failure reason is checkable.
- Prefer state reachable by URL for `browser` criteria: a route with query parameters can be captured, while a state that needs five clicks may not be.
- Do not tag something `browser` only because it is in the UI; if a component test can assert it, it is `test`.
- A `manual` criterion reads as an instruction to the owner, with the observation in its Expected line: the Action is "Owner: send a real password reset to your own address" and the Expected is "the email arrives within a minute and its link opens the reset form".
