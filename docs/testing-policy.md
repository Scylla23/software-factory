# v1 testing policy

## Threat model

The v1 factory runs only repositories the owner controls.
Project code is trusted and may contain bugs.
Issue text, PR comments, web content, and dependency content remain untrusted, and prompt-injection defenses stay in place.
Defer tests that assume a hostile project, including the R3 project-command verdict substitution arm and other project-side substitution attacks, until the factory runs repositories the owner does not control. [[before untrusted repos] Restore hostile-project controls](https://github.com/Scylla23/software-factory/issues/45)

## Required coverage and controls

- Validate inputs at trust boundaries.
- Preserve gate integrity, including owner identity, approvals, SHA binding, and protection against edited and replayed comments.
- Protect secrets and tokens.
- Handle errors that could cause data loss.
- Keep side effects crash-safe and idempotent.
- Prevent agents from pushing.
- Enforce the deny-read list for secrets.
- Enforce agent write roots.

## Ordinary tests

Non-trivial logic ships with real tests in the existing `bun test` setup.
Run one full suite while iterating.
At the end of a round, run three consecutive full suites and typecheck.
Fix flaky tests when observed.

## Mutation checks

Mutation checks are required only for code covered by the required coverage and controls above.
Reporting, pricing, docs, catalogs, and formatting do not require mutation checks.
Keep the existing mutation scripts and add mutants only for the required coverage and controls.

## Claude CLI and Codex CLI safety proofs

- Prove that agents cannot write outside their write roots.
- Prove that agents cannot read the deny-list.
- Run the home-clean preflight and its post-run check.
- Run the personal-leak probe.
- Prove that roles forbidden from calling subagents have no subagent tool.
- Prove that agents cannot push or reach GitHub credentials.

Re-run the applicable safety proofs when a pinned CLI version changes.
Track other undocumented-behavior proofs, including discovery locations and additional facts in the skills delivery design, as deferred issues.

## Skill evals

Run one trial per case variant and rerun a failure once to distinguish a flaky result from a reproducible failure.
Cap Claude spend per step at $10 API-equivalent, measured with `src/usage`, and stop before starting a session whose estimate does not fit.
Codex spend is uncapped.
Fix fixture or rubric defects in separate commits and base each correction exclusively on the skill or spec text.

## Reviews

Run one cross-vendor review, one repair round, and one narrow re-check.
File new non-blocking findings as issues.

## Existing tests

Keep all passing tests.
This policy governs new tests and which checks gate a step.
