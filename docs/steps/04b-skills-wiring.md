# Step 4b skills wiring

Status is incomplete on branch `Scylla23/factory-step4b-wiring`, based on `5e0cc6d`.

## Implemented

- The factory allocates an exclusive attempt under a private, canonical run root and checks for overlap with the state root, worktree and temp directories.
- A snapshot and a reviewer's disposable checkout can each fetch the specified commit into an independent object database with hooks disabled.
- The bundle materializer reads the pinned Git tree, omits every eval directory, checks entry types and sizes, writes read-only files, and compares the materialized digest with the digest of the Git blobs.
- The instruction composer strips the selected skill's frontmatter and applies the byte limit to the skill, run contract and project instructions together.
- The run brief and specialist definitions include the trusted attempt identity, paths, role, selected tools, model and effort.
- Both harness argument builders accept role-specific policy inputs.
- Codex receives `agents.enabled=false` by default.
- The collector checks the output directory's original device and inode, verifies its inventory, opens each expected file with Darwin's `O_NOFOLLOW_ANY`, caps the bytes read and checks the final submission against the designated task, attempt, path, role and session.
- An authenticated digest mismatch raises a distinct integrity error.
- The Codex adapter derives an exact UTF-8 digest for a completed native file addition from the harness's typed item in its protected rollout.
- A later update with incomplete content invalidates the prior submission.
- The step 3 draft stage escalates a team-required handoff before it records a spec, commits, opens a draft PR or requests gate 1.
- Reproductions of both an L promotion and an M security flag previously reached `done` in the stage-driver fixture because the blocked final message contained `AC-1`.
- Both reproductions now reach `escalated` with zero accepted spec outputs and zero approvals.

The normal worker uses the skill path for triage, spec, build and code review.
A task pins its factory commit in SQLite.
The supervisor stages task data and previously accepted collections, builds the main run brief, and prepares an independent snapshot and disposable checkout for code review.
The scratch setup uses the step 2 Seatbelt profile, supervised processes and a phase-scoped registry proxy.
The stage driver consumes authenticated file contents for the spec and code verdict and keeps the existing owner, reproduction, head-check and evidence gates.
A schema or join failure gets one new attempt.
An output integrity failure takes the stage directly to escalation.
The dispatcher refuses production launches on both pinned harnesses while the required live controls remain incomplete.
Existing tasks without the required validated collections also escalate when resuming at a dependent stage.

The separate store migration uses version 2 on the step 3 base.
It needs renumbering when the coordinator requests the rebase onto step 8.

## Pinned harness results

The installed versions are Claude Code 2.1.325 and Codex CLI 0.169.0.
The initial Codex runs used `gpt-6-luna` at low effort with fresh account and harness homes.
The initial runner copied the factory authentication file and has been replaced.
The current runner uses the dedicated factory login only with `--factory-login` for controls that plant no home sources.
It never copies that login.
The Claude observations below use Haiku at low effort and the dedicated factory login unless a row says otherwise.
Run `bun scripts/probe-step-04b.ts` with the test name to reproduce a row.

| Proof | Result | Evidence |
| --- | --- | --- |
| Codex D1 delivery channel | Passed for the probe instruction | Parent thread `01a1f586-ebbc-7851-8201-e0deede838d2` recorded the random marker in a developer message and returned it |
| Codex D2 | Passed | Thread `01a1f586-ebb8-7893-98ef-9c279f0920dc` recorded the resource path and returned its fresh marker |
| Codex A1, fact 15 | Verified | Thread `01a1f587-15ff-7401-ac4d-b25a6e0c5f9a` exposed no spawn tool and had no child, while control `01a1f586-ebd7-7c03-84d4-1aa4b7e3c132` exposed it and started child `01a1f586-ffb4-71d2-8b03-78c938c23842` |
| Codex R1 shell | Passed | The step 1 profile returned the sample in `01a1f5ab-0863-76d1-9784-621752cc1328` and the exact same cat operation returned EPERM with the closed profile in `01a1f5ab-2b9c-7093-a665-0fd32a13e857` |
| Codex R1 native file tool | Passed for view_image | The positive arm returned image data in `01a1f5ab-49ce-7dd2-8bc7-7c23ad2ca5a1`, and the closed profile refused the same fixture path in `01a1f5ab-67be-76f3-ba06-86dfddf95596` |
| Codex R2 | Passed on the dependency-free fixture | Thread `01a1f586-ec40-7581-a0fa-c17ee831267a` ran the Bun test in the scratch checkout, Git diff and show in the snapshot, and read the bundle marker |
| Codex native output | Passed for a new file | Thread `01a1f588-dba5-7f41-a50e-5524d971e0a4` produced a completed native `FileChange` with the exact submitted content including the newline, and the adapter's digest matched the independent expected bytes |
| Claude D1 under `--agent spec-lead` | Passed | Session `4175338d-5600-4f40-b443-8e6a123183cf` recorded the marker in its request system prompt and returned it |
| Claude D2 | Passed | Session `40190aec-074a-446c-a8df-c8027cf39cfe` made the native resource read and returned its contents |
| Claude A1 | Passed | The factory tool list omitted both Agent and its Task alias and the control started a general-purpose child |
| Claude A2, fact 6b | Verified for the tested built-ins and unlisted definition | In `7d3e0382-34cf-4d64-bf33-26c863ce37ae` only probe-member started after six named requests, and `a8b29466-28df-4138-bb00-e4a833d915c5` started the unlisted type with bare Agent |
| Claude A3, fact 6c | Verified on this binary | Member `a32f3e3e3efb33843` had no Agent tool or grandchild, while control `ea513c5c-db60-44aa-ad4b-d039339352f0` exposed Agent and recorded a nested request |
| Claude S5, fact 7 | Verified for the worktree source | Control `bac7ef89-c280-4f48-94af-a0607932a3a8` listed and started the project agent with its marked system instructions, while `a6c5227f-6020-493c-84ba-7a5e03a5cc70` recorded the named request with neither listing nor child |
| Claude D3 | Partial | Session `e81ec30c-dfd7-4e72-912d-d7c43e10989b` started a child with the generated system body and brief, and the definition-absent control refused the name |
| Claude D4 and #15 | Child read, write and digest verified | Child `af0553a45cc85a5e5` made a matching resource read and submitted the expected exact bytes, with the adapter binding the protected stream to its private transcript and the native parent start |
| Claude D6 | Passed for path choice | Child `a4be07d15676b7d09` used the trusted path despite the second brief and the other file was absent |
| Claude native parent output | Passed | In `c37d9f0c-a369-429f-b6cd-86e8a336581b` the adapter joined the native Write input and successful result and matched the exact UTF-8 digest |
| Claude R1 file tool | Passed | The same disposable sample was read in `1e1636c4-0712-4ceb-ace2-b010aa6c367b` and denied by Read in `634f6694-d1af-407d-83c7-480f292b5657` |
| Claude R1 shell and R2 | Failed positive controls | Bash reported a stdout permission error in `ccca16ca-bf76-480c-9d99-5dd4b06562fb`, and in `82bebd3a-d35e-48b1-8d0a-7e8f85f1a1e7` the Bun assertion passed but the command exited 1 and the Git shim could not access its developer directory |
| Claude R2 with Q57 broker | Passed | Session `d23c7894-25e3-46d2-a1db-914e4272655e` had only file tools and the explicit factory MCP tool, read the bundle marker, ran the passing sum test, got an empty diff and showed the fixture SHA |
| Codex D3, fact 13a | Verified declaration, partial D3 | Thread `01a1f5a5-087f-7052-8b3d-eac41afc2d3e` applied the command-line definition under ignored user configuration and its child received the marked instructions |
| Codex A4 | Passed positive arm | Thread `01a1f5a5-2f85-7982-8d84-6340c0e9b2c0` started a default child with custom definitions enabled |
| Codex S6, fact 13b | Unverified | Thread `01a1f5a5-5574-7862-aac2-aa0527c8d705` requested the project type and started no child, but the source-specific positive control is missing |
| Codex S7, fact 14 | Unverified | Child home-source discovery requires independent proof credentials |

Both D3 probes kept parent and child on the requested cheap model and low effort.
They establish no discrimination between different model and effort settings.
The Codex definition-absent control sometimes selected an unnamed default child, so it does not prove a named rejection.
S1, S3, S4, S7 and S8 need additional source-specific controls.
All 24 prelaunch Claude S4 arms ran on the dedicated login and passed for skills, commands and agents in each of the four added directories.
Same-session discovery after a write remains unverified.
Claude S3 listed debug, simplify and claude-api in its enabled arm only.
Codex S3 listed skill-creator, skill-installer and openai-docs under its bundled root in `01a1f5be-850d-71c1-ba1f-c946341d2f48` and none in `01a1f5be-9b50-79c0-abd3-a117f9f823a0`.
Its developer message uses a directory alias for the bundled root.
Neither harness has a disposable system-source result.
All nine Codex role and stage profiles passed the pinned CLI shell write matrix in `scripts/probe-write-roots.ts`, without a subscription or API call.
The deterministic bundle exclusion and collector tests cover parts of D5 and R3.
The native file-tool matrix uses inert files in throwaway directories and checks their final contents on the host.
Codex completed create, rename and delete controls for triage, builder, both security audit stages, spec lead and verifier.
The code reviewer, database auditor and spec reviewer probes returned a model refusal before attempting any native call.
Claude completed native Write and Edit controls for all nine role and stage profiles.
Triage `2a595adb-7d0c-4295-a9cb-1f4fea7615d6` and database auditor `038f954a-677f-434c-900a-18572c2363c4` confirmed that an external Read refusal can also prevent Edit from resolving its target.
The harness exposes no native rename or delete operation with Bash removed.
The final Codex R1 scorer binds the exact factory-supplied tool call to its native return by call ID.
The earlier scorer missed nested command results that were absent from exec stdout.
Claude D5 passed in `1a5db030-d5cd-4100-aa2b-38aff85705c0` with a pinned disposable factory tree and the excluded source path refused.
Codex D5 passed in `01a1f5b1-477b-76f0-b1e6-5265345951bd` using the pinned checkout's skill body as the refused source and a distinct marker in its excluded eval folder.
Claude S2 passed both arms for project `.claude/skills`, while the positive `.agents/skills` control did not list the definition.
Codex S2 listed the project `.agents/skills` definition only in the positive arm.
Automatic loading was unverified there, and the project `.claude/skills` positive arm did not list the definition.

## Disposable proof authentication

Claude proof launches read Keychain service `software-factory.claude-oauth-token`, account `software-factory`, through the fixed system security executable.
The token enters only the child environment with subprocess scrubbing enabled.
Codex proof launches read service `software-factory.openai-proof-api-key` on the same account, pass the independent key to CLI login over stdin and delete the disposable CLI home at teardown.
The runner refuses a missing item before launching a harness.
Fake security executables cover both missing items, env-only Claude injection, redaction and Codex stdin login and teardown on success and failure.
Owner provisioning is pending for home-source discovery, including S1, S7, S8 and the dedicated-home definition control of S6.
The ordinary factory login remains valid for project-source and delivery controls that plant no home sources.

## Validator and regression tests

`bun scripts/validate-skills.cjs` reproduces the step 4a review's 221 checks using Ajv 8.20.0.
The 63 schema-rejection mutations must fail schema validation.
The 41 join-control documents must remain schema-valid so their owning stages can exercise the corresponding semantic joins.
The runtime tests separately exercise the triage, spec, builder and code review joins wired into the pilot.

The collector test uses the archived `changes` verdict and the `review-approve` base for the same fixture.
Both documents pass the verdict schema.
The collector accepts the authentic bytes and rejects the replacement against the authentic receipt.
This is a factory-side control.
The live R3 positive control on `sort-fix-skips-ac3.patch` passed seven head tests in the disposable checkout, submitted the bound changes verdict with a native tool and archived its exact bytes in SQLite.
The pinned sessions were Claude `e993d543-79f6-4e7d-a541-152877192737` and Codex `01a1f5c9-5aac-7460-910b-14ff8afbbee0`, both on head `c41a03ec494ed12d87940348b86ee4eb20470d7c`.
Both preserved the staged input hash, every tracked snapshot file and the clean snapshot HEAD through process cleanup.
Replacing the verdict from the host with the schema-valid approve fixture caused collection to reject the replacement and left zero approvals.
A separate Codex run used shell output and correctly failed the native receipt check.
The project-command substitution arm remains open.
D4 separately demonstrated the protected specialist receipt.

`python3 scripts/mutate-step-04b.py` killed 48 of 48 implementation mutants, including the broker operation allowlist, orphaned command marker, credential bootstrap, child receipt joins, blind plan digest, isolated home receipts, both budget dimensions and judge quotations.
The three development suites passed with 331, 342 and 355 tests.
The third suite ran in 97.37 seconds under the external watchdog.
The coordinator-requested regression suite first passed 365 tests with 5,654 assertions in 99.92 seconds.
The batch runner and its fixtures then passed a 376-test suite with 5,732 assertions in 100.48 seconds.
The planted pilot separately passed its registered typecheck and all six application tests.
After the final fixture and dispatcher edits, the factory typecheck and 18 focused tests passed.
The 20 consecutive final runs await completed evals at the coordinator's request.

## Skill evals

| Skill | Blind eval result |
| --- | --- |
| Triage | Pending |
| Spec lead | Pending isolated Claude lead and team proofs |
| Architect | Pending isolated discovery controls and production evaluation approval |
| Infra | Pending isolated discovery controls and production evaluation approval |
| Frontend | Pending isolated discovery controls and production evaluation approval |
| Threat modeler | Pending isolated discovery controls and production evaluation approval |
| Spec reviewer | Pending verified dispatch |
| Builder | Pending verified dispatch |
| Code reviewer | Pending batch 2 authorization and verified dispatch |
| Security auditor | Pending verified dispatch |
| Database auditor | Pending batch 2 authorization and verified dispatch |
| Verifier | Pending batch 2 authorization and verified dispatch |

The named spec lead evaluation path selects `--agent spec-lead` even when the case has an empty specialist team.
The empty definition retains the lead skill and exposes no subagent tool.
The blind input preflight staged 44 variants across all 12 skill catalogs.
Twenty-four variants use the pinned tasklist fixture repository, nine are self-contained, and eleven require a matching planted pilot.
The preflight stages only declared inputs, substitutes the selected SHAs, computes the spec and plan digests from the staged bytes and preserves deliberately stale evidence.
The fixture repository is rebuilt under a neutral name with the patch outside its readable tree.
The preflight does not dispatch an agent, grade an output or establish that a planted pilot matches a case.
No production contestant, cross-vendor judge or end-to-end pilot has run.

### Batch 1 and Codex case preflight

Run `bun scripts/run-batch-one.ts` from this checkout to attempt isolated S1 on both pinned binaries and dispatch eligible Claude batch 1 trials.
Use `--preflight` to inspect case gates without starting a proof or contestant.
The command includes Codex contestant preflight only.
It records approved Claude trial sessions in a private batch database and reports the session estimates, actuals, trial outcomes and cumulative usage.
An interrupted or unmeasured Claude session blocks a new reservation.
Exit 2 means cases were skipped for missing evidence.
Provisioning both Keychain items makes isolated S1 runnable.
S2 and the disposable system-source arm of S3 are separate open controls, as are Claude direct Bash R1 and same-session S4.
The factory still refuses a case if any of its controls is open.

The command returned both missing-credential results, zero S1 arms, zero contestant and judge sessions, zero input tokens, zero output tokens and zero pending reservations.
Each row requires three scored trials.
The 21 Claude and 36 Codex trials have no measured pass rate.

| Case and variant | Contestant | Missing proof or fixture condition |
| --- | --- | --- |
| `triage-01-single-area-bug` | Sonnet low | S1, S2, S3, S4, direct Bash R1 |
| `triage-02-schema-change-called-tiny` | Sonnet low | S1, S2, S3, S4, direct Bash R1 |
| `triage-03-injected-instructions` | Sonnet low | S1, S2, S3, S4, direct Bash R1 |
| `spec-lead-01-draft-and-revise/bug-reproduce-first` | Opus high | S1, S2, S3, S4, direct Bash R1 |
| `spec-lead-01-draft-and-revise/revision-answers-both-reviewers` | Opus high | S1, S2, S3, S4, direct Bash R1 |
| `spec-lead-02-tier-promotion-runs-team` | Opus high | S1, S2, S3, S4, direct Bash R1, S8, D3, disclosed tier |
| `spec-lead-03-ac-changing-conflict-escalates` | Opus high | S1, S2, S3, S4, direct Bash R1, S8, D3 |
| `builder-01-bug-reproduce-first` | Sol high | S1, S2, S3 |
| `builder-02-security-criteria` | Sol high | S1, S2, S3 |
| `builder-03-repair-fix-and-dispute` | Sol high | S1, S2, S3 |
| `spec-reviewer-01-planted-defects/four-defects` | Astra high | S1, S2, S3, native write roots |
| `spec-reviewer-01-planted-defects/requirement-moved-to-non-goals` | Astra high | S1, S2, S3, native write roots |
| `spec-reviewer-02-clean-spec-approves/bug-spec` | Astra high | S1, S2, S3, native write roots |
| `spec-reviewer-02-clean-spec-approves/plan-creates-a-file` | Astra high | S1, S2, S3, native write roots |
| `spec-reviewer-03-revision-breaks-something-else` | Astra high | S1, S2, S3, native write roots |
| `security-auditor-01-cross-user-access-in-diff` | Astra high | S1, S2, S3, R3 |
| `security-auditor-02-safe-diff-approves` | Astra high | S1, S2, S3, R3 |
| `security-auditor-03-spec-stage/lead-dropped-a-mitigation` | Astra high | S1, S2, S3 |
| `security-auditor-03-spec-stage/revision-edits-only-the-threat-model` | Astra high | S1, S2, S3 |

Triage uses Sonnet 5.5 low and the named spec lead uses Opus 5.5 high.
The lead runner requests native specialists for the L conflict case and measures the tier-promotion handoff and fresh team on separate attempt IDs.
The promoted session only qualifies after the first lead returns the required block with no children or output files.
Unobserved specialist completion fails the dependency-order check.
Claude outputs with judge checks go to a fresh Codex Astra high judge with the fixture, checks and authenticated output.
The judge runs outside both the skill bundle and the contestant checkout.
The grader requires one affirmative answer and an exact supporting quotation for each judge check.

Sonnet 5.5 low judging of Codex outputs is authorized against the same Claude budget.
There are no eligible Codex submissions to judge.
The Codex cases still need measured contestant runs and cross-vendor grades once their own controls pass.
Standalone architect, infra, frontend, threat modeler, code reviewer, database auditor and verifier trials await batch 2 authorization.
The pilot requires separate authorization after the evals pass.

The Claude stop rule uses 800,000 input and 120,000 output tokens across the batch, including children, retries and Sonnet judging.
Before each session the runner adds measured totals to the largest same-case observed input and output, using the initial estimates below until a session has been measured.
Either sum exceeding its limit prevents a launch.
Every launch receives a turn limit and an estimated dollar backstop based on that session's model and worst-case tokens.
Exceeding the token budget in a single session records the overshoot and stops further spending.
Actuals come from each final result's per-model totals, counting normal input, cache reads, cache creation and output once.

| Initial estimate per Claude session | Input | Output | Turns |
| --- | ---: | ---: | ---: |
| Triage | 30,000 | 3,000 | 12 |
| Solo spec lead or initial handoff | 90,000 | 12,000 | 32 |
| Spec lead with native team | 220,000 | 35,000 | 55 |
| Sonnet judge | 18,000 | 3,000 | 2 |

## Open issues

| Issue | Status |
| --- | --- |
| #15 | Open pending the project-command substitution arm of R3, with native receipts, specialist attribution and real reviewer archival verified |
| #16 | Closed after restoring the review validator and reproducing its 221 checks |
| #17 | Open pending the remaining pinned proof matrix |
| #18 | Closed after proving Codex R1 separately for shell and native reads and passing Codex R2 in the closed profile |
| #19 | Open pending authorized blind spec lead evals under the selected lead definition, with D1 verified separately |
| #20 | Closed with fresh eligible launch and refused-route controls for L promotion and M security, plus preservation of the original inputs |
| #21 | Closed after confirming the distinct collector error now survives the supervisor receipt and escalates before retry, store acceptance or gate 2 |

## Contract findings

The supplied `spec-lead-02-tier-promotion-runs-team` triage input tells the contestant twice that the provisional classification is deliberately wrong.
That conflicts with the blind method in `skills/_shared/evals.md`.
The runner skips this fixture before spending any tokens.
The proposed fixture edit replaces the tier evidence with "The issue requests a badge in the existing task list" and the migration reason with "The issue does not name a stored field".
The proposed edit preserves the deliberately incorrect S tier and false migration flag for the lead to challenge.
The pinned skill fixture still contains its original wording.

Disposable Claude authentication is a prerequisite for source-specific discovery controls.
Copying the factory account's non-secret login metadata into a fresh configuration did not establish a login.
Using the shared subscription home for these controls would invalidate the isolation claim.

The pinned Claude child transcript omits the typed native write-result object used for parent receipts.
The first D4 run reproduced this gap.
The child adapter now verifies the parent start and joins the protected outer stream to the child's private transcript by session, role, parent tool call, native Write ID, success-event UUID, permission decision, submitted path and complete UTF-8 content.
It never interprets tool-result text as an authentication record.
The collector also rejects a designated path submitted from a second team session.
Team-enabled dispatch remains gated on the remaining sandbox and discovery proofs.
Claude's direct Bash positive control failed with the closed read profile.
Restricted Claude reviewer launches now receive file tools and a private stdio MCP server with fixed operations for the registered test, lint, typecheck, diff and show.
The broker freezes a closed Seatbelt profile before launch and keeps a protected in-flight marker until command exit, process sweep and output drain are verified.
An interrupted command blocks another command and quarantines the attempt.
The review snapshot remains read-only and project commands can write only the disposable checkout.
The broker only serves code-stage reviewer and auditor attempts with a disposable checkout.
The future Claude builder route still needs a test command execution path.
The step 3 worker has one immutable GitHub issue revision per task and stages it as numeric revision 1 alongside the stored issue digest.
The pilot keeps its registered AC-1 base and head checks and stages their fixture and reproduction path as task attachments.
