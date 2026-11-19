# Read and update one task by id

Tier: S - Builder: Sol 6.2 - Code reviewer: Opus 5.5
Task: github Scylla23/factory-pilot#102 revision 1
Flags: none

## Problem

The API can list a user's tasks but cannot return or change a single task.
The client needs `GET /api/tasks/:id` and `PATCH /api/tasks/:id` to show and edit one task.

## Non-goals

- No task deletion and no change to task creation.
- No new dependency.

## Acceptance criteria

### AC-1: Read one of the caller's tasks

- Tag: test
- Fixture: user 1 owns one task titled `mine`.
- Action: `GET /api/tasks/<id>` as user 1.
- Expected: status 200 and a body whose `title` is `mine`.

### AC-2: Other users' tasks are protected

- Tag: test
- Fixture: two users with tasks.
- Action: request a task as the wrong user.
- Expected: access control works correctly.

## Design choices

- Put the owner check in the shared guard so every route uses the same rule.

## Reused files

- `src/api/tasks.ts`: `handle` and the `json` helper.
- `src/api/auth.ts`: the `requireOwner` guard, applied to the new route.
- `src/api/tasks.test.ts`: the `call` helper and the `resetTasks` setup.

## Implementation plan

1. Add the `GET /api/tasks/:id` route to `handle`, wrapped in `requireOwner` (files: `src/api/tasks.ts`, `src/api/auth.ts`; serves AC-1, AC-2).
2. Add one test per criterion (files: `src/api/tasks.test.ts`; serves AC-1, AC-2).

## Risks

None.

## Open questions

None.
