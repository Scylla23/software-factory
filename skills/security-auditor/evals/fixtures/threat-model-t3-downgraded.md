# Threat model: read and update one task by id

## Decision

The change adds two routes that address a task by its id, so the main risk is one signed-in user reaching another user's task.
Both routes must look the task up by owner and id together.
With that control the change adds no risk beyond the existing list route.

## Options considered

- Answer 403 for another user's task: rejected, because it confirms that the id exists.
- Answer 404 for another user's task: chosen, so a foreign task is indistinguishable from a missing one.
- Accept any task field in the update and filter afterwards: rejected, because a missed field becomes writable.

## Rationale

The project already scopes every read by owner in `findTask` and `listTasks`, and its conventions forbid a lookup by id alone.
Reusing `findTask` keeps the authorization rule in one place instead of in each route.

## Assets and actors

- Assets: each user's tasks (title, due date), and the integrity of a task's owner and id.
- Actors: an anonymous caller (no session), a signed-in user acting on their own tasks, and a signed-in user supplying another user's task id.

## Entry points

| Id | Entry point | Path or file | Actor | Data crossing |
|---|---|---|---|---|
| E-1 | GET /api/tasks/:id | `src/api/tasks.ts` | signed-in user | task id in the path |
| E-2 | PATCH /api/tasks/:id | `src/api/tasks.ts` | signed-in user | task id in the path, JSON body |

## Threats

| Id | Entry point | Threat | Rating | Mitigation | Verified by |
|---|---|---|---|---|---|
| T-1 | E-1 | User B reads user A's task by supplying its id. | high | Look the task up with `findTask(session.userId, id)`; a foreign task returns 404 with no task data. | AC-3 |
| T-2 | E-2 | User B changes user A's task by supplying its id. | high | The same owner-scoped lookup before any write. | AC-3 |
| T-3 | E-2 | A user sets `ownerId`, `id`, or another unlisted field through the update body, moving a task to another account or corrupting it. | low | None in this task. | Accepted |
| T-4 | E-2 | A caller sends a very large body or many updates to exhaust the server. | low | None in this task. | Accepted |

## Proposed acceptance criteria

None.
AC-3 of the draft already states the negative case.

## Required changes to acceptance criteria

None.

## Accepted risks

- T-3: the only client is the project's own web app, which sends only `title` and `due`, so other fields are not expected in practice.
- T-4: the store is in memory and the routes do no expensive work; request limits belong to the hosting layer and are out of scope for this task.

## Security path globs

- `src/api/**`: every route reads or writes per-user data.

## Curated entries used

- `parse-dont-validate` (pattern, architecture): the update body is parsed into a typed patch at the boundary.

## Catalog gaps

None.

## Assumptions

- The session passed to `handle` is established and verified by code outside this change.
