# Decision files and catalog discipline

The four specialists of the spec team each write exactly one decision file in the task folder.
The spec lead merges them into the spec, and for a new project the factory copies them to the project's `docs/decisions/`, where they bind later work.
Write for that later reader: a builder a month from now who has only this file.

Each file is a member of the spec file set, so it is reviewed, hashed, and approved with the spec, and only its author may change it.
When two decision files disagree and the spec lead resolved it, the files stay as written and the resolution governs: it is recorded in the spec under Conflicts resolved and in `spec-lead.json`, and the factory writes it to `docs/decisions/resolutions.md` beside the copied files.
A later reader who finds a decision file and `resolutions.md` in disagreement follows `resolutions.md`.

## Format

Use these headings, in this order, and no others at level 2.
The factory and the spec reviewer parse the two list sections, so keep their line format exact.

```markdown
# <Architecture | Infrastructure | Frontend | Threat model>: <task title>

Task: <taskId>
Author: <architect | infra | frontend | threat-modeler>

## Decision

<What will be built or used, stated as decisions, not options.>

## Options considered

<Each real alternative, one short paragraph: what it is, why it lost.>

## Rationale

<Why the decision fits this task's acceptance criteria and constraints.>

## Curated entries used

- `<entry-id>` (<kind>, <catalog>): <what it is used for here>

## Catalog gaps

- <need>: <why no catalog entry fits>. Unapproved candidate: <name or "none">.

## Assumptions

- <something you could not verify and what changes if it is false>
```

Write `None.` as the only line under a list section that has no items.
Skill-specific sections, where a skill defines them, go between Rationale and Curated entries used.
Keep the file under 200 lines; a decision that needs more is several decisions, and the lead needs to know that.

## Catalog discipline

The owner curates the catalogs so that every project draws on the same small set of choices.
A pick outside the catalog silently spends the owner's review attention on a technology nobody vetted, so the rule is strict:

1. Pick only from `entries` in your catalog (`catalog.json` in your skill folder).
   Never pick from `dropped`; those failed verification.
2. An entry with `status: "flagged"` may be picked, but repeat its `flagReason` in your Rationale.
3. `kind` decides what an entry permits.
   `inspiration` is reference only: name it as a pointer for humans, and never copy its assets, text, or code.
   `library` may be added as a dependency, using exactly the names in `packages` and the method in `install`.
   `install: "npm"` is the only method the factory can carry out: it installs the package from the registry at the version the entry's evidence records, so do not state a version of your own.
   `install: "cli"` and `install: "copy-paste"` put source into the repository from the entry's own site, which the factory cannot reach.
   Pick such an entry only when that source is already in the repository, and cite its path; otherwise still name it as your decision, and say under Assumptions that the owner must add its source to the repository before any build, which the lead takes to the owner as a blocking question.
   `service` may be adopted, and needs an account and credentials only the owner can provide, so list it under owner prerequisites.
   `pattern` is a preferred approach; `anti-pattern` is something to name when you reject a tempting option.
4. Packages that an approved entry's own installer adds are covered by that entry.
5. For an existing project, the project's own components, dependencies, and conventions win over the catalog.
   Cite the project file instead of a catalog entry, and do not introduce a catalog alternative to something the project already has.
6. When nothing fits, do not go outside the catalog.
   Record the gap under Catalog gaps, decide the rest, and say what the decision would be if the gap were filled.
   The spec lead takes gaps to the owner.
7. Honor `whenToUse` and `avoidWhen`.
   Picking an entry in a situation its `avoidWhen` describes needs a stated reason.

You have no network.
You cannot open a catalog URL, so do not describe what a site shows today; rely on the entry's own fields and your knowledge of the technology, and list anything version-specific under Assumptions.
