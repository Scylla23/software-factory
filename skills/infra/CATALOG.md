# Infrastructure catalog: approved choices per category

Seeded defaults for the owner to edit.
One to three approved choices per category; the first listed in a category is the default.
Verified on 2026-11-19; method and results are in [catalog-verification.md](../_shared/catalog-verification.md).
This index is for people; agents and the factory read [catalog.json](catalog.json), which is the source of truth.

## Hosting

| id | Name | Category | When to use | Avoid when |
|---|---|---|---|---|
| `cloudflare-workers` | [Cloudflare Workers](https://developers.cloudflare.com/workers/) | hosting | Default for small web apps and APIs that fit the Workers runtime, and for static sites. | Workloads that need long-lived processes, native Node or Bun modules, or a local filesystem. |
| `vercel` | [Vercel](https://vercel.com/docs) | hosting | Next.js applications. | Long-running background work or WebSocket servers; a project not built on a framework Vercel targets. |
| `railway` | [Railway](https://docs.railway.com/) | hosting | Long-running Bun or Python servers, workers, and anything that needs a container and a private network. | Static sites and edge-shaped apps, which are cheaper on Cloudflare Workers. |

## Database

| id | Name | Category | When to use | Avoid when |
|---|---|---|---|---|
| `neon` | [Neon Postgres](https://neon.com/docs/introduction) | database | Default relational database for a hosted app; branch per preview when migrations are risky. | Single-user or embedded tools where a local SQLite file is enough. |
| `turso` | [Turso (libSQL)](https://docs.turso.tech/) | database | Small apps that want SQLite semantics with a hosted primary, or a database per tenant. | Workloads that need Postgres features: rich types, extensions, heavy concurrent writes. |
| `drizzle-orm` | [Drizzle ORM](https://orm.drizzle.team/) | database | Default TypeScript schema, query, and migration layer for Postgres and SQLite. | A project that already uses another ORM or migration tool; follow it. |

## Auth

| id | Name | Category | When to use | Avoid when |
|---|---|---|---|---|
| `better-auth` | [Better Auth](https://www.better-auth.com/) | auth | Default authentication for a TypeScript app that owns its user table. | The owner wants hosted user management, organizations, and compliance handled by a vendor; use Clerk. |
| `clerk` | [Clerk](https://clerk.com/docs) | auth | Hosted authentication with prebuilt user and organization management. | The app must own its user data and sessions, or must run its preview with no outbound network and real sign-in. |

## Email

| id | Name | Category | When to use | Avoid when |
|---|---|---|---|---|
| `resend` | [Resend](https://resend.com/docs) | email | Default transactional email provider. | Bulk marketing email. |
| `postmark` | [Postmark](https://postmarkapp.com/developer) | email | Transactional email where delivery reputation and message streams matter more than developer convenience. | Bulk marketing email. |
| `react-email` | [React Email](https://react.email/) | email | Building and previewing email templates as React components. | Plain-text emails with no layout. |

## Queues

| id | Name | Category | When to use | Avoid when |
|---|---|---|---|---|
| `inngest` | [Inngest](https://www.inngest.com/docs) | queues | Multi-step background workflows that need retries, sleeps, and fan-out, on serverless hosting. | A single fire-and-forget job in an app that already has Postgres; use pg-boss. |
| `pg-boss` | [pg-boss](https://github.com/timgit/pg-boss) | queues | Background jobs in an app with a long-running server and Postgres, without adding infrastructure. | Serverless hosting with no long-running worker, or a database that is not Postgres. |
| `cloudflare-queues` | [Cloudflare Queues](https://developers.cloudflare.com/queues/) | queues | Queued work for an app already hosted on Cloudflare Workers. | Apps hosted elsewhere. |

## Payments

| id | Name | Category | When to use | Avoid when |
|---|---|---|---|---|
| `stripe` | [Stripe](https://docs.stripe.com/) | payments | Default payments and subscriptions when the owner handles tax and compliance as the seller. | The owner wants a merchant of record to handle sales tax and VAT; use Polar. |
| `polar` | [Polar](https://polar.sh/docs) | payments | Selling software subscriptions or digital products with a merchant of record handling tax. | Physical goods, marketplaces, or payment flows the merchant of record does not support. |

## Analytics

| id | Name | Category | When to use | Avoid when |
|---|---|---|---|---|
| `posthog` | [PostHog](https://posthog.com/docs) | analytics | Product analytics, funnels, and feature flags for an app with signed-in users. | A content or marketing site that only needs page views; use Plausible. |
| `plausible` | [Plausible](https://plausible.io/docs) | analytics | Privacy-friendly page and referrer analytics for sites and landing pages. | Per-user product analytics and funnels; use PostHog. |

## CI

| id | Name | Category | When to use | Avoid when |
|---|---|---|---|---|
| `github-actions` | [GitHub Actions](https://docs.github.com/en/actions) | ci | Default CI for test, lint, typecheck, and deploy workflows. | Projects not hosted on GitHub, or a project that already has another CI system; do not add a second one. |
| `renovate` | [Renovate](https://docs.renovatebot.com/) | ci | Automated dependency update pull requests. | A project the owner updates by hand on purpose. |

## Observability

| id | Name | Category | When to use | Avoid when |
|---|---|---|---|---|
| `sentry` | [Sentry](https://docs.sentry.io/) | observability | Default error tracking for any deployed app. | Local tools and libraries with no deployment. |
| `opentelemetry` | [OpenTelemetry](https://opentelemetry.io/docs/) | observability | Instrumenting traces and metrics in a vendor-neutral way once an app has more than one service or slow paths to explain. | A single small app where error tracking is enough; do not add tracing speculatively. |
| `axiom` | [Axiom](https://axiom.co/docs) | observability | Central structured logs and events when the host's own log view is not enough. | Apps whose host already retains and searches logs well enough. |
