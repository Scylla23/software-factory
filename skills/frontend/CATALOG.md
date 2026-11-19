# Frontend catalog: inspiration, fonts, and approved libraries

Seeded defaults for the owner to edit.
Inspiration entries are reference only; fonts and libraries are installable.
Verified on 2026-11-19; method and results are in [catalog-verification.md](../_shared/catalog-verification.md).
This index is for people; agents and the factory read [catalog.json](catalog.json), which is the source of truth.

## Inspiration

Reference only: point to these for a pattern, and never copy assets, text, or code from them.

| id | Name | Category | When to use | Avoid when |
|---|---|---|---|---|
| `navbar-gallery` | [Navbar Gallery](https://www.navbar.gallery/) | navbar | Choosing a navigation pattern for a marketing site or app shell: top bar, mega menu, mobile drawer, sticky behavior. | The project already has a navigation component; extend that instead. |
| `footer-design` | [Footer](https://www.footer.design/) | footer | Structuring a site footer: link columns, newsletter capture, legal row, how much to put in it. | In-app screens, which rarely need a marketing footer. |
| `land-book` | [Landbook](https://land-book.com/) | landing-page | Surveying whole landing pages by industry or style before fixing a page structure. | Deciding a single component; use the component-level entries instead. |
| `saaslandingpage` | [SaaS Landing Page](https://saaslandingpage.com/) | landing-page | Landing pages for a software product: section order, proof, pricing placement, calls to action. | Non-software or editorial sites. |
| `landingfolio` | [Landingfolio](https://www.landingfolio.com/) | landing-page | Comparing how individual landing sections (pricing, testimonials, features, FAQ) are built across sites. | App UI work. |
| `supahero` | [Supahero](https://supahero.io/) | hero | Designing the hero section: headline, supporting line, primary action, and visual arrangement. | Pages with no hero, such as dashboards and settings. |
| `cta-gallery` | [CTA.gallery](https://www.cta.gallery/) | call-to-action | Closing sections and inline calls to action on marketing pages. | In-app primary actions, which follow the app's own button hierarchy. |
| `bentogrids` | [Bento Grids](https://bentogrids.com/) | layout | Feature overviews or dashboards-as-marketing laid out as a bento grid. | Dense data screens; a bento grid trades information density for looks. |
| `minimal-gallery` | [Minimal Gallery](https://minimal.gallery/) | layout | Restrained, typography-led layouts for portfolios, studios, and editorial pages. | Feature-heavy product marketing that needs more structure than a minimal page gives. |
| `dark-mode-design` | [Dark Mode Design](https://www.darkmodedesign.com/) | layout | Designing a dark theme: surface layering, contrast, accent use. | Projects that ship light mode only. |
| `mobbin` | [Mobbin](https://mobbin.com/) | app-ui | Finding how shipped products design a specific app screen: onboarding, settings, empty states, billing. | Marketing pages. Full access needs a paid account, so cite the pattern, not a deep link. |
| `refero` | [Refero](https://refero.design/) | app-ui | Searching real web app screens by page type or element when Mobbin lacks the case. | Marketing pages. Full access needs a paid account. |
| `saasframe` | [SaaSFrame](https://www.saasframe.io/) | app-ui | Reference screens for common SaaS surfaces: dashboards, pricing pages, onboarding, transactional emails. | Consumer or content products. |
| `pageflows` | [Page Flows](https://pageflows.com/) | user-flow | Designing a multi-step flow (sign-up, checkout, upgrade, cancel) and deciding step order. | Single static screens. Full access needs a paid account. |
| `component-gallery` | [The Component Gallery](https://component.gallery/) | component-reference | Naming a component correctly and seeing how established design systems build it, including its accessibility notes. | Page-level layout decisions. |
| `shape-of-ai` | [The Shape of AI](https://www.shapeof.ai/) | ai-interface | Choosing interaction patterns for AI features: prompts, streaming, citations, regeneration, human approval. | Interfaces with no AI behavior. |
| `typewolf` | [Typewolf](https://www.typewolf.com/) | typography | Picking a font pairing and seeing it used on real sites. | Choosing a font that is not in this catalog's font list; flag the gap instead. |
| `fonts-in-use` | [Fonts In Use](https://fontsinuse.com/) | typography | Checking how a specific typeface from the font list behaves in real layouts. | Choosing a font that is not in this catalog's font list; flag the gap instead. |
| `web-interface-guidelines` | [Web Interface Guidelines (Vercel)](https://vercel.com/design/guidelines) | guidelines | Setting the quality bar for interaction details: focus, forms, loading, motion, touch targets. | Never; treat as the default checklist for any web UI, below the project's own conventions. |
| `aria-apg-patterns` | [ARIA Authoring Practices Guide patterns](https://www.w3.org/WAI/ARIA/apg/patterns/) | guidelines | Specifying keyboard and screen-reader behavior for a custom widget: dialog, combobox, menu, tabs, listbox. | Native HTML elements already give the behavior; prefer the native element. |

## Fonts

Self-hosted through the listed package; every package declares the SIL Open Font License.

| id | Name | Category | When to use | Avoid when |
|---|---|---|---|---|
| `font-inter` | [Inter](https://rsms.me/inter/) | font | Default UI sans for dense product interfaces, tables, and forms. | A brand that needs a distinctive voice; Inter is neutral by design. |
| `font-geist` | [Geist and Geist Mono](https://vercel.com/font) | font | A modern UI sans with a matching mono, for developer-facing products. | Long-form reading; pair with a serif from this list instead. |
| `font-ibm-plex` | [IBM Plex Sans and Mono](https://www.ibm.com/plex/) | font | Technical or data products that want more character than Inter, with a matching mono. | Playful or consumer brands. |
| `font-jetbrains-mono` | [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | font | Code blocks, terminals, and tabular figures. | Body text. |
| `font-instrument-sans` | [Instrument Sans](https://fonts.google.com/specimen/Instrument+Sans) | font | Marketing pages and headings that need a warmer sans than Inter. | Dense data tables. |
| `font-instrument-serif` | [Instrument Serif](https://fonts.google.com/specimen/Instrument+Serif) | font | Large display headlines on landing and editorial pages. | Body text or small sizes; it is a display face with one weight. |
| `font-fraunces` | [Fraunces](https://fonts.google.com/specimen/Fraunces) | font | Expressive headings where the brand wants personality. | Neutral product UI. |
| `font-source-serif-4` | [Source Serif 4](https://fonts.google.com/specimen/Source+Serif+4) | font | Long-form reading: docs, articles, changelogs. | Compact UI labels. |
| `font-newsreader` | [Newsreader](https://fonts.google.com/specimen/Newsreader) | font | Editorial layouts that want a news-style text and headline serif. | Compact UI labels. |

## Libraries

The only frontend dependencies a spec may add without asking the owner.

| id | Name | Category | When to use | Avoid when |
|---|---|---|---|---|
| `cmdk` (flagged) | [cmdk](https://github.com/dip/cmdk) | command-palette | A command palette or keyboard-first searchable menu in a React app. | A plain select or autocomplete over a short fixed list; use the project's select or combobox. |
| `beautiful-ui` | [Beautiful UI](https://www.beautifului.dev/) | ai-interface | AI-native surfaces: chat prompt bar, streaming text, thinking traces, tool chips, human approval cards, task rows. | Interfaces with no agent or chat behavior, or a project whose design system already has these parts. |
| `shadcn-ui` | [shadcn/ui](https://ui.shadcn.com/) | components | Default component set for a new React and Tailwind project: buttons, dialogs, forms, tables, menus. | An existing project with its own component library; its components win. |
| `radix-ui` | [Radix Primitives](https://www.radix-ui.com/primitives) | primitives | An accessible unstyled primitive (dialog, popover, menu, tabs) that shadcn/ui does not already wrap. | The shadcn/ui component exists; add that instead of the raw primitive. |
| `react-aria-components` | [React Aria Components](https://react-aria.adobe.com/) | primitives | Complex accessible widgets Radix does not cover well: date and time pickers, drag and drop lists, grid lists, internationalized inputs. | Simple overlays and menus already covered by shadcn/ui or Radix; do not mix two primitive systems for the same widget. |
| `tailwindcss` | [Tailwind CSS](https://tailwindcss.com/) | styling | Default styling for a new web project. | An existing project styled another way; follow its convention. |
| `motion` | [Motion](https://motion.dev/) | animation | Layout, presence, gesture, or orchestrated animation that CSS transitions cannot express. | Simple hover, fade, or slide effects; use CSS transitions. |
| `lucide` | [Lucide](https://lucide.dev/) | icons | Default icon set for interface icons. | Brand logos or illustration; a project that already ships another icon set. |
| `tanstack-query` | [TanStack Query](https://tanstack.com/query/latest) | data-fetching | Client-side server state: caching, background refetch, optimistic mutations, pagination. | Data rendered on the server by the framework's own loader, or purely local UI state. |
| `tanstack-table` | [TanStack Table](https://tanstack.com/table/latest) | tables | Data tables that need sorting, filtering, column control, or pagination. | A static table with a handful of rows; use plain table markup. |
| `react-hook-form` | [React Hook Form](https://react-hook-form.com/) | forms | Forms with client-side validation, many fields, or field arrays. | A single input or a form fully handled by server actions without client validation. |
| `zod` | [Zod](https://zod.dev/) | validation | Parsing and validating untrusted input at a boundary: forms, API payloads, environment, URL params. | A project already standardized on another schema library. |
| `sonner` | [Sonner](https://sonner.emilkowal.ski/) | feedback | Transient confirmations and non-blocking errors. | Errors the user must act on; show those inline next to the cause. |
| `recharts` | [Recharts](https://recharts.github.io/) | charts | Standard line, bar, area, and pie charts in a React app. | Very large series or custom visual forms that need canvas or a lower-level library; flag the gap. |
| `date-fns` | [date-fns](https://date-fns.org/) | dates | Date arithmetic and formatting beyond what Intl.DateTimeFormat covers. | Formatting a date for display only; use the platform Intl API. |
| `nuqs` | [nuqs](https://nuqs.dev/) | url-state | State that must survive reload and be shareable or capturable by URL: filters, tabs, pagination, open panels. | Ephemeral state such as hover or an unsaved draft. |
| `zustand` | [Zustand](https://zustand.docs.pmnd.rs/) | state | Client state shared across distant components that is not server state and not URL state. | State one component tree can own with useState or context; server data (use TanStack Query). |
| `ai-sdk` | [AI SDK](https://ai-sdk.dev/) | ai-interface | Streaming model output and chat state from a TypeScript backend to a React client. | A feature that makes one non-streaming model call on the server; call the provider SDK directly. |
| `streamdown` | [Streamdown](https://streamdown.ai/) | ai-interface | Rendering model output as Markdown while it streams, including incomplete blocks. | Static Markdown content known at build time. |

## Dropped

Failed verification; not available to agents.

| id | Reason |
|---|---|
| `godly` | The URL now redirects to a different site (recent.design), so the entry as named no longer exists. |
| `lapa-ninja` | Could not be verified: 403 to curl and the page did not finish loading in the Orca browser. |
| `siteinspire` | Could not be verified: 429 security checkpoint to curl and the page did not finish loading in the Orca browser. |
| `vaul` | Abandoned: the repository README states 'This repo is unmaintained'; latest release 2024-12-14. |
| `next-themes` | Fails the maintenance rule: latest release 2025-03-11 and last commit 2025-05-31. |
| `dnd-kit` | The stable package @dnd-kit/core last released 2024-12-05, and its successor @dnd-kit/react is still 0.x; no stable maintained package to approve. |
