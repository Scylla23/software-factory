# Shared skill resources

Files here are used by more than one skill and are delivered with every skill bundle (see [docs/skills-delivery.md](../../docs/skills-delivery.md)).
This folder is not a skill: it has no `SKILL.md` and is never selected as a role.

| File | Used by | Purpose |
|---|---|---|
| [run-contract.md](run-contract.md) | every skill | The run brief, the task folder, and the rules of every run. |
| [verdict.schema.json](verdict.schema.json) | spec-reviewer, code-reviewer, security-auditor, database-auditor | The one verdict shape the factory validates. |
| [verdict.md](verdict.md) | the same four | How to decide, number, and re-review. |
| [decision-file.md](decision-file.md) | architect, infra, frontend, threat-modeler, spec-lead | Decision file format and catalog discipline. |
| [catalog.schema.json](catalog.schema.json) | architect, infra, frontend | Shape of every `catalog.json`. |
| [catalog-verification.md](catalog-verification.md) | skill-author | How catalog entries were verified and how to re-verify. |
| [evals.md](evals.md) | step 4b eval runner | The shape of an eval case and how one is judged. |
| [evals/tasklist/](evals/tasklist/README.md) | evals of spec-reviewer, builder, code-reviewer, security-auditor, database-auditor, verifier | A fixture repository with planted defects, task folders, patches, and build reports. |

Other output schemas live with the skill that writes them: `triage/triage.schema.json`, `spec-lead/spec-lead.schema.json`, `builder/build-report.schema.json`, `verifier/plan.schema.json`, and `verifier/results.schema.json`.
`verifier/evidence-index.schema.json` is the one schema for a file the factory writes: the evidence the verifier judges.
All schemas are JSON Schema draft 2020-12.
Every schema, catalog, fixture, eval file, and JSON example in a `SKILL.md` was validated with Ajv 8 (`ajv/dist/2020`) when it was authored, together with mutated documents that each schema must reject.
Under Ajv's strict mode the schemas need `strictTypes: false`, because their conditional subschemas deliberately leave out `type`.
