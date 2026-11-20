# Read and update one task by id

Tier: M - Builder: Sonnet 5.5 - Code reviewer: Sol 6.2
Task: github Scylla23/factory-pilot#102 revision 1
Flags: security

## Problem

The API can list a user's tasks but cannot return or change a single task.
The client needs `GET /api/tasks/:id` and `PATCH /api/tasks/:id` to show and edit one task.

## Non-goals

- No task deletion and no change to task creation.
- No change of a task's owner or id through the API.
- No new dependency.

## Acceptance criteria

### AC-1: Read one of the caller's tasks

- Tag: test
- Fixture: user 1 owns one task titled `mine`.
- Action: `GET /api/tasks/<id>` as user 1.
- Expected: status 200 and a body whose `title` is `mine`.

### AC-2: Update one of the caller's tasks

- Tag: test
- Fixture: user 1 owns one task titled `mine`.
- Action: `PATCH /api/tasks/<id>` as user 1 with body `{"title":"renamed","due":"2026-12-01"}`, then independently `GET /api/tasks/<id>` as user 1.
- Expected: both responses have status 200 and the subsequent GET returns the submitted title and due date.

### AC-3: Another user's task is not found

- Tag: test
- Fixture: user 1 owns one task titled `mine`; user 2 owns none.
- Action: `GET` and then `PATCH /api/tasks/<id>` as user 2, the patch with body `{"title":"stolen"}`.
- Expected: both return status 404 with no task data in the body, and the task's title is still `mine` when user 1 reads it.

### AC-4: Unknown fields are rejected

- Tag: test
- Fixture: user 1 owns one task titled `mine`.
- Action: `PATCH /api/tasks/<id>` as user 1 once with body `{"title":"renamed","ownerId":2}` and independently with `{"title":"renamed","id":99}`.
- Expected: both requests return 400 and a subsequent read at the original id returns the original task.

## Design choices

- Reuse `findTask(ownerId, id)` so the owner scope lives in one place, as the project conventions require.
- Answer 404, not 403, for another user's task so that task ids cannot be probed.
- Parse the patch body field by field; only `title` and `due` may change.

## Reused files

- `src/api/tasks.ts`: `findTask`, `handle`, and the `json` helper.
- `src/api/tasks.test.ts`: the `call` helper and the `resetTasks` setup.

## Implementation plan

1. Add the two routes to `handle`, looking the task up with `findTask` and the session's user id (files: `src/api/tasks.ts`; serves AC-1, AC-3).
2. Add a body parser that accepts only `title` and `due` and rejects anything else, and apply it in the `PATCH` route (files: `src/api/tasks.ts`; serves AC-2, AC-4).
3. Create `src/api/task-by-id.test.ts`, a new file beside the existing API tests, with one test per criterion built on the same `call` helper pattern (files: `src/api/task-by-id.test.ts`, new; serves AC-1, AC-2, AC-3, AC-4).

## Risks

- A lookup by id alone would expose every user's tasks; AC-3 exists to catch it.

## Open questions

None.
