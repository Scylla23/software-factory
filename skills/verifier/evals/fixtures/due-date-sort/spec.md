# Sort the task list by due date

## Problem

The task list sorts formatted day labels as text, so 10 Nov appears before 2 Nov.

## Acceptance criteria

### AC-1: Reproduce and fix ascending due-date order

- Tag: test
- Fixture: The seeded tasks are due 20 Nov, 10 Nov and 2 Nov 2026, in that order.
- Action: Sort by due date ascending.
- Expected: The dates are 2 Nov, 10 Nov and 20 Nov in order.
  The original sort puts 10 Nov first.

### AC-2: Descending due-date order

- Tag: test
- Fixture: Use the same three dated tasks.
- Action: Sort by due date descending.
- Expected: The dates are 20 Nov, 10 Nov and 2 Nov in order.

### AC-3: Undated tasks

- Tag: test
- Fixture: Add an undated task to the three dated tasks.
- Action: Sort by due date in each direction.
- Expected: The undated task sorts last in both directions.

### AC-4: Show the sorted dates on the task list

- Tag: browser
- Fixture: Use `seeded-tasks` with the three dated tasks.
- Action: Open `/tasks?sort=due&dir=asc` on desktop at 1440x900 and on mobile at 390x844.
- Expected: The Due column and its 2 Nov, 10 Nov and 20 Nov values are visible in that order at both sizes.
  Loading the page produces no new console errors.

### AC-5: Owner confirmation on production data

- Tag: manual
- Fixture: The owner's production task list.
- Action: The owner sorts their tasks by due date.
- Expected: The owner confirms that the order matches their production dates.
