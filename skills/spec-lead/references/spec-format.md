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

The example is from an expense tracker.

```markdown
# Monthly report total shows a rounding error

Tier: S - Builder: Sol 6.2 - Code reviewer: Opus 5.5
Task: github example-org/ledger#41 revision 1
Flags: none

## Problem

The monthly report adds expense amounts as floating point numbers, so a month with expenses of 0.10, 0.20, and 0.40 shows a total of 0.7000000000000001.
The owner expects 0.70.
Amounts are stored as decimal strings and are correct; only the report's sum is wrong.

## Non-goals

- No change to how amounts are stored or to the expense form.
- No currency conversion and no new report columns.
- No change to the totals of other reports.

## Acceptance criteria

### AC-1: Reproduction - three expenses total 0.70

- Tag: test
- Fixture: one month with three expenses of 0.10, 0.20, and 0.40.
- Action: compute the monthly total.
- Expected: the total is the string 0.70; on base the test fails because the total is 0.7000000000000001.

### AC-2: A month with no expenses totals 0.00

- Tag: test
- Fixture: one month with no expenses.
- Action: compute the monthly total.
- Expected: the total is the string 0.00.

### AC-3: The report shows the total

- Tag: browser
- Route: /reports?month=2026-10
- Fixture: the `seeded-expenses` project fixture.
- Action: load the route.
- Expected: the row labeled Total shows 0.70 at both viewports.

## Design choices

- Sum in integer cents and format once at the end, rather than adding a decimal library; every amount has two decimal places and the project has no numeric dependency.
- Keep the sum in the report module; the stored amounts are unchanged.

## Reused files

- `src/reports/total.ts`: the `monthlyTotal` function; only how it adds changes.
- `src/expenses/parse.ts`: the `parseAmount` validator, which already rejects amounts with more than two decimal places.
- `src/reports/total.test.ts`: the existing test style for report functions.

## Implementation plan

1. Add the failing reproduction for AC-1 to the report tests, run it, and confirm it fails for the stated reason (files: `src/reports/total.test.ts`; serves AC-1).
2. Change `monthlyTotal` to add integer cents and format the result with two decimal places (files: `src/reports/total.ts`; serves AC-1, AC-2).
3. Add the test for an empty month (files: `src/reports/total.test.ts`; serves AC-2).
4. Confirm the report route renders the Total row from `monthlyTotal` with the seeded fixture (files: none expected; serves AC-3).

## Risks

- An amount with more than two decimal places would lose precision in cents; `parseAmount` rejects those on input, and AC-1 and AC-2 use two-place fixtures.

## Open questions

None.
```

## Notes on writing criteria

- Name the fixture precisely enough that two people would build the same starting state.
- Put the bug's wrong result in AC-1's Expected line, as in the example, so the reproduction's failure reason is checkable.
- Prefer state reachable by URL for `browser` criteria: a route with query parameters can be captured, while a state that needs five clicks may not be.
- Do not tag something `browser` only because it is in the UI; if a component test can assert it, it is `test`.
- A `manual` criterion reads as an instruction to the owner, with the observation in its Expected line: the Action is "Owner: send a real password reset to your own address" and the Expected is "the email arrives within a minute and its link opens the reset form".
