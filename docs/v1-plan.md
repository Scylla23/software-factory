# Software Factory - v1 Plan

The [design](design.md) describes the factory.
The [testing policy](testing-policy.md) governs coverage, proofs, evals, and reviews for every step from 4b onward.

## Done

- **0. GitHub App** ([#7](https://github.com/Scylla23/software-factory/pull/7)) - The owner created the private App and verified installation access to `factory-pilot`.
- **1. Dispatch and Orca visibility** ([#9](https://github.com/Scylla23/software-factory/pull/9)) - The dispatch spike established the sandboxed CLI path in Orca worktrees.
- **2. Verification** ([#12](https://github.com/Scylla23/software-factory/pull/12), [#14](https://github.com/Scylla23/software-factory/pull/14)) - The factory can run sandboxed previews and capture evidence in the Orca browser, and Q56 authorizes publishing screenshots to private PRs.
- **3. Walking skeleton** ([#33](https://github.com/Scylla23/software-factory/pull/33)) - `factory run <issue-url>` took a real bug through spec, gate 1, build, factory-run checks with base/head reproduction, cross-vendor code review, browser verification, and gate 2 on [factory-pilot PR #5](https://github.com/Scylla23/factory-pilot/pull/5).
- **4a. Skill authoring** ([#32](https://github.com/Scylla23/software-factory/pull/32)) - The roles' skills, catalogs, and delivery proposal were merged.
- **8. Usage and cost** ([#42](https://github.com/Scylla23/software-factory/pull/42)) - Usage capture, cost estimates, and `factory cost` and `factory status` are in place.
- **4b. Skill wiring** ([#55](https://github.com/Scylla23/software-factory/pull/55)) - The skills replace the hand-written prompts; a planted bug went through the skill-driven path on [factory-pilot PR #12](https://github.com/Scylla23/factory-pilot/pull/12).

## 5. Checks, evidence and review loops

Paused (2026-11-20): the owner first trials the real project both Orca-native (bots, orchestration, and these skills) and with `factory run`, and builds this step only if the factory path is the one in use.

- Before gate 1, validate spec review verdict files against the current spec revision and review each revision diff against the blocking findings and acceptance criteria.
  Cap the loop at three rounds and escalate unresolved findings to the owner.
  Bind gate 1 to the approved spec revision.
- Keep and harden factory-run test, lint, and typecheck before code review.
  Require the bug reproduction to fail for the approved reason on base and pass on head, and block weakened or deleted tests.
- Require cross-vendor code review with `file:line` and acceptance criterion citations.
  After a repair, rerun checks, review, and verification against the repaired revision.
- Publish a per-criterion evidence table to the PR, including before/after UI screenshots under Q56 and an owner checklist for manual criteria.
  Bind evidence to its revisions, redact published evidence, and require the owner's recorded observation for each manual criterion.
  Block criteria with missing required observations.
- Give the owner a recovery command for infrastructure escalations that preserves the revision and cleanup guards ([#34](https://github.com/Scylla23/software-factory/issues/34)).
- Add fixed auditor triggers only if they fit the existing review flow with little work.
  Use a configured security path glob for the security auditor and migration paths for the database auditor.

## v1 ready: start the real project

The owner scaffolds the first real project with lint, tests, and `AGENTS.md`, registers it in `factory.config.ts`, and installs the GitHub App on it.
The owner applies the `factory` label and drives each issue through `factory run <issue-url>` from the CLI.
Real use decides what to add next.

## Backlog (add when real use needs it)

- **Tier routing** - Add tier assignment, promotion, and tier-to-model mappings when different classes of work repeatedly need different models from the fixed config.
- **Observed-model enforcement** - Extend today's model checks and enforce reviewer and verifier vendor pairs against the actual builder when mismatches or owner overrides recur.
- **Spec-lead subagent team** - Qualify the native handoff, decision provenance, and conflict resolution when complex specs repeatedly need specialist input.
  Compare specs with and without the team before adopting it.
- **Auditor triggers** - Revisit fixed path triggers if they were deferred, or add spec-flag triggers if diffs repeatedly miss work that needs specialist review.
- **Daemon** - Add launchd, two-minute polling, and `throttled` retries when manually invoking the CLI or waiting on provider limits becomes a recurring bottleneck.
- **Daemon crash recovery** - Make run-root and attempt cleanup and judge retry recovery crash-safe before running unattended.
- **Judge calibration** - Plant subtle bugs, skipped criteria, and weakened tests when real use shows reviewers or verifiers may be missing defects.
- **Evidence validation** - Validate the links between the verification plan, capture index, and results when tasks need proof from several sources or repeated judging of one capture.
- **Spec path and collision checks** - Add field-by-field grounding and gate-time creation-target collision checks when specs repeatedly point at invalid paths or propose occupied paths.
- **Owner feedback edges** - Add transitions and a separate budget beyond `/respec` and `/reverify` when the owner repeatedly needs to send changes back through a gate.
- **Escalation diagnostics** - Retain rejected worktrees when the owner needs the rejected diff to resolve an escalation.
- **Automatic rebase** - Rebase and rerun review, checks, and verification when base drift repeatedly stalls otherwise valid runs.
- **Hostile-project controls** - Restore the hostile-project proof gates before running any repository the owner does not control ([#45](https://github.com/Scylla23/software-factory/issues/45)).
- **Disposable proof logins** - Use isolated logins for paired home-source discovery proofs when a harness or policy change requires proof at those sources ([#44](https://github.com/Scylla23/software-factory/issues/44)).
- **Claude builder command path** - Prove closed-read project commands in the writable worktree before enabling Claude as a builder ([#43](https://github.com/Scylla23/software-factory/issues/43)).
- **Additional harness proofs** - Complete the deferred skill-delivery and source-discovery observations when a harness or skill rollout depends on them ([#46](https://github.com/Scylla23/software-factory/issues/46)).
- **Usage follow-ups** - Make the native Haiku fixture reproducible and tighten feedback ordering and fragment deduplication tests when metering or feedback behavior next changes.
- **Linear, WhatsApp, and Teams inputs** - Add adapters in that order when the owner needs to start work in those channels regularly.
- **Model benchmarking** - Replay completed tasks with held-out checks when there is enough real work to compare quality, cost, and owner rework across models.
- **House template** - Extract conventions from the first real project when setting up another project would repeat the work.

### Open issue mapping

| Issue | Title | New home |
| --- | --- | --- |
| [#22](https://github.com/Scylla23/software-factory/issues/22) | [step 5] Implement plan, evidence-index and results joins, including judge retry identity, withheld text producing blocked rows, and the screenshot digest mutation | Backlog - Evidence validation |
| [#23](https://github.com/Scylla23/software-factory/issues/23) | [step 5] Implement test-integrity baseline comparison and marking-vs-base checks, with the sort replay and unrelated-failure controls | Step 5 |
| [#24](https://github.com/Scylla23/software-factory/issues/24) | [step 5] Implement redactor `[withheld]` substitution and the `notExecuted` path for lost capture identity | Step 5 |
| [#25](https://github.com/Scylla23/software-factory/issues/25) | [step 6] Implement per-field path confinement and the creation-target approval/collision control | Backlog - Spec path and collision checks |
| [#26](https://github.com/Scylla23/software-factory/issues/26) | [step 6] Implement verdict joins (`tested=true` on approval, resolutions coverage, finding numbering) and spec-set invalidation at gate 1 | Step 5 |
| [#27](https://github.com/Scylla23/software-factory/issues/27) | [step 7] Define deterministically which decisions a revision "affects", so the inheritance join does not rest on the lead's own claim | Backlog - Spec-lead subagent team |
| [#28](https://github.com/Scylla23/software-factory/issues/28) | [step 7] Enforce reviewer/verifier vendor pairs against the actual builder, including owner overrides | Backlog - Observed-model enforcement |
| [#29](https://github.com/Scylla23/software-factory/issues/29) | [step 7] Verify team membership, child-session authorship and inherited provenance before spec acceptance | Backlog - Spec-lead subagent team |
| [#30](https://github.com/Scylla23/software-factory/issues/30) | [step 7] Generate `docs/decisions/resolutions.md` from `spec-lead.json` conflicts | Backlog - Spec-lead subagent team |
| [#31](https://github.com/Scylla23/software-factory/issues/31) | [step 9] Make run-root and attempt-directory reaping crash-safe, and resume a judge retry from the immutable capture after a daemon crash | Backlog - Daemon crash recovery |
| [#34](https://github.com/Scylla23/software-factory/issues/34) | [step 5] Give infrastructure escalations an owner recovery command | Step 5 |
| [#35](https://github.com/Scylla23/software-factory/issues/35) | [step 5] Pin the store-level resume guards and the JUnit failure type with tests | Step 5 |
| [#36](https://github.com/Scylla23/software-factory/issues/36) | [step 5] Bound the stage loop in tests so a repair-loop regression fails instead of hanging | Step 5 |
| [#37](https://github.com/Scylla23/software-factory/issues/37) | [step 9] Keep the worktree when a builder diff is rejected as Uncertain | Backlog - Escalation diagnostics |
| [#38](https://github.com/Scylla23/software-factory/issues/38) | [step 5] Write the JUnit report where project tests cannot predict or rewrite it | Step 5 |
| [#39](https://github.com/Scylla23/software-factory/issues/39) | [step 9] Pin the step 8 gate-2 feedback order and fragment dedupe with tests | Backlog - Usage follow-ups |
| [#40](https://github.com/Scylla23/software-factory/issues/40) | [step 9] Collect gate-2 feedback only when a review exists | Backlog - Daemon |
| [#41](https://github.com/Scylla23/software-factory/issues/41) | [step 9] Make the Haiku subagent fixture capture reproducible from the repo | Backlog - Usage follow-ups |
| [#43](https://github.com/Scylla23/software-factory/issues/43) | [step 5] Prove a closed-read command path before enabling the Claude builder | Backlog - Claude builder command path |
| [#44](https://github.com/Scylla23/software-factory/issues/44) | [step 9] Prove home-source discovery with disposable logins | Backlog - Disposable proof logins |
| [#47](https://github.com/Scylla23/software-factory/issues/47) | [step 7] Qualify the native spec-team handoff and completion | Backlog - Spec-lead subagent team |
