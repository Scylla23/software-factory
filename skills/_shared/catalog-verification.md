# Catalog verification

The three catalogs (`architect/catalog.json`, `infra/catalog.json`, `frontend/catalog.json`) are seeded defaults for the owner to edit.
Every entry was fetched on 2026-11-19, and each records its own `verifiedAt` and `evidence`.
The skill author repeats this procedure whenever an entry is added or changed, and for the whole catalog when `verifiedAt` is more than 6 months old.

## What was checked

1. Live URL: `curl -L` on `url` with a 30 second limit; the status after redirects is `evidence.httpStatus`.
   A URL that redirects to a different site is treated as gone.
2. Release: for each name in `packages`, `https://registry.npmjs.org/<package>` gives the `latest` version, its publish date, its license, and any deprecation notice.
3. Repository: the GitHub API gives `archived` and the date of the last commit on the default branch, and the latest release date when the project publishes releases.
4. Description: the page title and meta description were read so that `whenToUse` describes what the entry is, not what it was remembered to be.

## The maintenance rule

A library or service SDK counts as maintained when it is not archived or deprecated and has an npm release or a default-branch commit within 12 months of `verifiedAt`.
Fonts are judged by their distribution package, because a finished typeface needs no commits.
An entry with no package and no public repository is judged by its live page alone, and its `evidence.note` says so.

## Outcomes

- An entry that passes is `status: "approved"`.
- An entry the owner named that fails the rule is kept as `status: "flagged"` with a `flagReason`, so agents can use it and must repeat the caveat.
- Anything else that fails is moved to `dropped` with the reason and the evidence, so nobody proposes it again without new evidence.

## Results on 2026-11-19

| Catalog | Entries | Flagged | Dropped |
|---|---|---|---|
| frontend | 48 (20 inspiration, 9 fonts, 19 libraries) | 1 (`cmdk`) | 6 |
| infra | 23 (18 services, 5 libraries) | 0 | 0 |
| architecture | 15 (11 patterns, 4 anti-patterns) | 0 | 0 |

Dropped from the frontend candidates:

- `godly`: the URL redirects to a different site.
- `lapa-ninja` and `siteinspire`: blocked for automated clients and did not load in a browser, so they could not be verified.
- `vaul`: its README states the repository is unmaintained.
- `next-themes`: no release or commit within 12 months.
- `dnd-kit`: the stable package is stale and its successor is still 0.x.

Two notes on evidence that is not a plain 200:

- `land-book` answers curl with a 403 bot challenge; it was loaded in an isolated Orca browser profile and its title recorded.
- `aria-apg-patterns` answers 200 to a plain curl request and 403 to one with a browser user agent.

Verified candidates that were left out to keep the lists short (not failures): Fly.io, Supabase, Trigger.dev, Better Stack, Base UI, AI Elements, assistant-ui, TanStack Virtual, Floating UI, react-day-picker, react-resizable-panels, embla-carousel, class-variance-authority, tailwind-merge, and several fonts and galleries.
The owner can add any of them; each needs the checks above first.

## Kinds beyond the design's two

The design defines `inspiration` and `library`.
The schema adds `service`, `pattern`, and `anti-pattern`, because an infra choice such as a hosted database is neither a reference nor an npm install, and an architecture pattern is neither.
`service` matters to the factory: it needs an account and credentials only the owner can provide, so a spec that picks one must list owner prerequisites.
