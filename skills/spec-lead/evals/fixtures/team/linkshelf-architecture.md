# Architecture: Linkshelf, a personal bookmark shelf

Task: eval-linkshelf
Author: architect

## Decision

Linkshelf is one deployable: a long-running Bun server that renders pages on the server, serves a small JSON API to its own pages, and runs the weekly digest as a scheduled job in the same process.
Code is organized by feature under `src/features/`, with shared infrastructure under `src/platform/`.
All database access goes through `src/platform/db/`, and every query for links takes the signed-in user's id as a required argument.
Email leaves the process only through the mailer port in `src/platform/mail/`.

## Options considered

A separate worker service for the digest was rejected: tens of users do not need a second deployable, and it would add a queue and a deploy to operate.
An edge-hosted app with a hosted cron trigger was rejected because the digest job and server-side sessions are simpler in one long-running process.
A single-page client with a separate API was rejected because no criterion needs client-side routing.

## Rationale

Every criterion is served by one process and one database, and the feature folders keep later tasks to one area each.
Making the user id a required argument of the data layer puts the per-user rule of AC-5 in one place instead of in every route.

## Modules

| Module | Path | Owns | May call |
|---|---|---|---|
| auth | `src/features/auth/` | sign-up, sign-in, sessions | platform |
| links | `src/features/links/` | saving, listing, tagging, search | platform |
| digest | `src/features/digest/` | weekly selection and email content | links, platform |
| platform | `src/platform/` | database client, mailer port, config, scheduler | nothing in features |

## Data ownership

| Entity | Owner module | Invariants |
|---|---|---|
| user | auth | Email is unique. |
| session | auth | Belongs to one user and expires. |
| link | links | Belongs to exactly one user; the URL is http or https. |
| tag | links | Unique per user by name. |
| digest run | digest | At most one sent digest per user per week. |

## External boundaries

| Service or effect | Adapter path | On failure or repeat | Fake for tests and preview |
|---|---|---|---|
| Outbound email | `src/platform/mail/` | A failed send is retried on the next run; the digest run record makes a repeat a no-op. | An in-memory outbox that a test and a preview page can read. |

## Deferred

- Fetching page titles from saved URLs: it adds outbound requests built from user input; the user types the title for now.
- Full-text search: a substring match meets AC-4 at this scale.

## Curated entries used

- `modular-monolith-first` (pattern, architecture): one deployable with feature modules.
- `vertical-slices` (pattern, architecture): the `src/features/` layout.
- `ports-and-adapters` (pattern, architecture): the mailer port and its fake.
- `idempotency-keys` (pattern, architecture): the digest run record keyed by user and week.
- `parse-dont-validate` (pattern, architecture): request bodies are parsed into typed values at each route.
- `microservices-first` (anti-pattern, architecture): the reason the digest worker is not a separate service.

## Catalog gaps

None.

## Assumptions

- The host can run one long-lived process with a scheduler; if it cannot, the digest needs an external trigger and this decision must be revisited.
