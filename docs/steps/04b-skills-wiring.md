# Step 4b skills wiring

## Factory-home decision and observations

The owner replaced disposable-login S1, system-source S3, S7 and S8 with a factory-home preflight and a negative-only personal-source probe.
Those four claims remain unproven.
Issue #44 tracks the paired disposable-login controls.
The batch report lists the effective preflight disposition for each case.

The original inventory refused both factory homes because the pinned CLIs had installed account-synced Claude skills and plugin manifests, and bundled Codex skills and cached remote plugins.
The coordinator approved retaining those sources at known disabled locations.
No cached source was removed and no personal configuration was changed.
Neither factory home had a settings file before this change.
In the factory Claude home, `settings.json` disables skill and plugin sync, Claude.ai connectors, auto memory and the four built-in plugins seen in earlier restricted init records.
The pre-plugin version of that settings file was backed up in private factory state.
The same settings travel in the launch arguments under restricted mode.
In the factory Codex home, `config.toml` disables skill instructions, bundled skills, plugins, remote plugins, apps and hooks.
The effective launch repeats the settings because Codex ignores the user config.
The S3 enabled controls listed debug, simplify and claude-api on Claude and skill-creator, skill-installer and openai-docs on Codex.
The clean-home probes listed none of these.
The configuration keys are documented in [Claude Code settings](https://code.claude.com/docs/en/settings) and verified against the installed binaries.

The inventory checks file types, account settings, source class and location before launch and again after exit.
The approved Claude sync bucket belongs to the factory account and organization.
The factory accepts updates to existing cached documents without pinning their content.
New locations, extra settings, linked inputs and unknown discovery classes refuse dispatch.
During concurrent Codex sessions the pinned binary creates a per-thread lock and an arg0 directory with two aliases for the pinned executable.
Only those exact aliases targeting the trusted executable qualify.
The postflight checks the session identity, model-visible instructions and Claude init or Codex rollout listing.
A missing transcript, a loaded source or a new source location quarantines the attempt and preserves its usage.

The personal probe enumerated 177 installed skill and agent names without reading their files.
Claude Haiku low session `fa2e95a6-e4b2-42a9-9204-e07684742faf` and Codex Luna low thread `01a1f755-95d8-7283-bcab-1ca823071c83` both passed.
These are negative-only observations without a personal-home positive control.
The discriminating D3 definition-absent arm `949a7054-7f2c-4a6b-b9b6-18936534e785` requested the named child and recorded no child start.
The definition-present arm `7afbbb77-87b8-4d44-8bc4-b44344b0e3b5` observed Haiku low as parent and Sonnet medium as the child, including the delivered brief and specialist system instructions.
Production and evaluation continue to require the applicable native controls and R3.


Step 4b remains incomplete on branch `Scylla23/factory-step4b-wiring`, rebased onto step 8 at `d88d164`.

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
The dispatcher refuses a role and stage whenever one of its required controls remains incomplete.
Existing tasks without the required validated collections also escalate when resuming at a dependent stage.

The separate store migration at `9ef662c` upgrades step 8's version 3 store and the earlier skill-only version 2 store to version 4.

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

Both original D3 probes kept parent and child on the requested cheap model and low effort.
They establish no discrimination between different model and effort settings.
The Codex definition-absent control sometimes selected an unnamed default child, so it does not prove a named rejection.
S1, the system-source arm of S3, S7 and S8 need additional source-specific controls.
All 24 prelaunch Claude S4 arms ran on the dedicated login and passed for skills, commands and agents in each of the four added directories.
Same-session discovery after a write was never measured live.
The coordinator replaced that arm with a prelaunch write prohibition for every skill role, described below.
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
Claude S2 listed and loaded project `.claude/skills` only in enabled session `e7fb4e55-a671-43a6-bd74-408f2fb8ae63`.
The factory-flags session was `91619044-f3ac-4553-8b7e-554cfeec3724`.
Codex listed project `.agents/skills` in enabled thread `01a1f5a7-7ff7-7613-8169-33115da35c7a` and then read the marked skill file in response to the named request.
The original scorer inspected only instruction messages and missed the native read.
Call `call_2200ae2ee58e49b0b084988b698c5d3e` used the exact file and checkout, and its matching protected tool result contained the skill name, fresh description and body marker.
Replaying the corrected scorer on the stored rollout passed without a provider request.
The factory-flags thread `01a1f5a7-a291-7460-9fdf-f732565016cd` had neither listing nor loaded body.
The Codex read was an explicit load after discovery.
For the alternate locations, neither harness listed or loaded the marked body in either arm.
The enabled alternate arms were Claude `0f752b09-ae7e-4f95-a577-6a32475ea927` and Codex `01a1f5a7-c8d0-7c72-8b79-a50fb592d150`.

## Coordinator decisions after 176b086

1. The coordinator approved neutral evidence and migration wording for `spec-lead-02-tier-promotion-runs-team`.
   Commit `81b10c5` updates the fixture while retaining its S classification, low confidence and false migration flag.
   All 44 variants were re-staged and the validator passed all 221 checks.
2. Direct Bash R1 applies only when the role receives Bash.
   Claude skill launches expose file tools, and code-stage reviewers and auditors use the registered-command broker.
   The generated lead and specialist definitions omit Bash and a skill session reporting Bash at initialization fails validation.
   The future Claude builder remains refused pending a proven project command path in [step 5 issue 43](https://github.com/Scylla23/software-factory/issues/43).
3. The coordinator replaced mid-session S4 with a write prohibition for every role, including the builder.
   Both harnesses protect `.claude`, `.agents`, `.codex`, `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md` and `CLAUDE.local.md`, including nested and mixed-case names.
   Codex applies filesystem deny globs and Claude applies native read, edit and write denials.
   The broker and reviewer dependency setup apply a Seatbelt write denial at the syscall.
   Skill policy preparation rejects symlinks and multiply linked files inside discovery sources.
   The builder diff guard escalates a protected change before publication.
   The separate instruction composer reads the approved project files from pinned Git blobs.
   The offline pinned proof `bun scripts/probe-discovery-writes.ts` allowed an ordinary write and denied eight protected destinations per harness, including one below a new directory.
   The new Codex check exercised the pinned sandbox shell, including refusal to rename or delete an existing protected file.
   The separate native Codex matrix retains the three unobserved role profiles recorded above.
   The Claude CLI used its native Write and Edit tools against a loopback response fixture with provider network access denied.
   A permitted edit succeeded and the protected original retained its bytes.
4. The coordinator accepts an unlisted and unloaded alternate directory as "not a source on the pinned binary" once the real source passes both arms.
   This disposition applies to Claude `.agents/skills` and Codex `.claude/skills`.
   Neither alternate showed automatic loading.
5. The coordinator retained the credential gates for S1, the S3 system source, S7 and S8.
   No paid proof or evaluation ran during this revision.
6. The coordinator accepts partial Claude D3 for step 4b only after a discriminating model and effort observation.
   The owner subsequently moved D3 to the audited factory login, with a Haiku 5.5 low parent and a Sonnet 5.5 medium child.
   The definition-absent arm must request the same child and record no start.
   The enabled arm must link the child to the parent start and verify its effective skill, run brief, model and request effort in the private transcript.
   Both live arms passed on the factory login.

## Optional disposable proof authentication for step 9

Claude proof launches read Keychain service `software-factory.claude-oauth-token`, account `software-factory`, through the fixed system security executable.
The token enters only the child environment with subprocess scrubbing enabled.
Codex proof launches read service `software-factory.openai-proof-api-key` on the same account, pass the independent key to CLI login over stdin and delete the disposable CLI home at teardown.
The runner refuses a missing item before launching a harness.
Fake security executables cover both missing items, env-only Claude injection, redaction and Codex stdin login and teardown on success and failure.
The owner deferred disposable proof credentials to step 9, including the source-specific home discovery and dedicated-home definition controls.
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

`python3 scripts/mutate-step-04b.py` killed 59 of 59 implementation mutants, including the broker operation allowlist, orphaned command marker, credential bootstrap, child receipt joins, blind plan digest, isolated home receipts, both budget dimensions, judge quotations, discovery write denials, lazy reads and specialist model selection.
The three development suites passed with 331, 342 and 355 tests.
The third suite ran in 97.37 seconds under the external watchdog.
The coordinator-requested regression suite first passed 365 tests with 5,654 assertions in 99.92 seconds.
The batch runner and its fixtures then passed a 376-test suite with 5,732 assertions in 100.48 seconds.
The planted pilot separately passed its registered typecheck and all six application tests.
The earlier batch-runner revision passed the factory typecheck and 18 focused tests.
Before step 8 merged, the suite passed 382 tests across 38 files, with 6,544 assertions in 95.80 seconds.
The factory typecheck passed and all nine Codex shell role profiles passed their offline write-root checks.
On the rebased branch the full suite passed 451 tests across 42 files with 6,755 assertions.
The typecheck and the 221 validator controls passed.
The mutation scripts killed all 71 step 4b mutants and all 48 step 8 mutants.
The staged revision preflight also passed its focused regression, including the corrected-digest control.
The 20 consecutive final runs await completed evals at the coordinator's request.

## Skill evals

The batch ran against skill tree `2f827fb52ec7d1ccaadc0f97bf6ca3cd784b793e` before and after rebasing onto `d88d164`.
The negative-only personal probes and the distinct D3 certificate qualified the eligible batch 1 routes.
The blind input preflight stages 44 variants across 12 catalogs.
The factory gave contestants only the staged inputs, a neutral fixture checkout, the skill bundle and the run brief.
A canary in the excluded eval tree and the native event stream check for answer leakage.
Project test commands used to grade builders run in disposable copies under the existing Seatbelt broker.

The [batch 1 report](04b-batch-one.md) records each case, variant, trial, model, native session, fresh input, cache reads, cache writes, output, failing checks and API-equivalent costs.
`bun scripts/report-step-04b.ts` reconstructs the report without launching a model.
`bun scripts/run-batch-one.ts --codex-only` resumes Codex contestants and deterministic grading with Claude disabled.
The twenty-run stability check and the end-to-end pilot remain deferred under the coordinator's stop instruction.

| Skill | Current disposition |
| --- | --- |
| Triage | Eight passes from nine trials, with the first case failing its third trial on the tier signal enum |
| Spec lead | One named solo trial failed the reused-path check despite passing all three judge checks, with eleven trials stopped before launch |
| Architect | Batch 2 authorization pending. |
| Infra | Batch 2 authorization pending. |
| Frontend | Batch 2 authorization pending. |
| Threat modeler | Batch 2 authorization pending. |
| Spec reviewer | Five variants refused before dispatch for the native write-root matrix. |
| Builder | Three trials per case on Sol high, with case dispositions in the batch report. |
| Code reviewer | R3 and batch 2 authorization pending. |
| Security auditor | Both code cases refused on R3, three spec submissions await a judge and three revision trials had an invalid fixture |
| Database auditor | R3 for code-stage review and batch 2 authorization pending. |
| Verifier | Batch 2 authorization pending. |

The coordinator's merge notice arrived after Claude reached its stop rule.
Step 8's capture reconciled each completed pre-merge session against its protected native evidence.
Five Codex contestants had already started when the notice arrived.
The sixth and later contestants ran after the rebase, typecheck, full suite and both mutation suites.
No contestant was repeated for the rebase.
A concurrent Codex session's runtime lock initially refused the solo spec lead's Codex judge before launch.
After validating the lock and the two pinned-executable aliases, the factory restored the exact original project commit by its hash and graded the saved authenticated submission once.
All six repository files cited in the reused-files section existed.
The literal path checker also treated the HTTP route `/tasks` in the explanation as a repository path.
The recorded check remains failed.
The coordinator approved checking the repo-relative file naming each reuse entry and allowing HTTP routes in the explanation.
The spec-lead skill defines each entry as an existing file or pattern and a description of what to reuse.
Its spec format puts the repo-relative path before the colon and illustrates that the description may contain other inline code.
The archived batch 1 report retains the score under the original rubric.
Offline rescoring of session `ef42a55b-4268-4af3-a0ea-43bad489ca9d` changed the result from 11/12 checks and a failed trial to 12/12 checks and a passed trial.
The rescore used the authenticated submission and its saved project file list and retained all eleven other recorded checks.

All 15 eligible Codex contestants finished.
The native file-tool gate refused 15 spec-reviewer trials and R3 refused six code-stage auditor trials before launch.
Eight builder trials and three auditor trials passed their deterministic checks and await a Sonnet judge.
Builder case 1 trial 3 lacked an authenticated final write of `build-report.json`.
The runner retained 14 judge packets for the 15 Codex contestants with their recorded inputs and authenticated outputs where available.
The 32 saved session catalogs passed the strengthened source-listing audit on offline replay.

The three spec-stage security-auditor revision trials had invalid inputs.
The fixture's round 1 verdict has a zero digest, which the shared eval method binds to the current spec set.
The revision identity check requires the archived digest to differ from that same current digest.
All three verdicts echoed the correct current digest `f03ed6eba730669f43e9410f8e93e8d6d089f0a0d9672f21b4d8af9ec2724ccb`.
The archived round 1 files independently hash to `0e99cceeabd1a308764ad0eedf5ed1c5ac9f8c8c50c964f3d4fc99e09e1c1439` under the section 6 algorithm.
The proposed fixture correction is to put that archived digest in `skills/security-auditor/evals/fixtures/task-by-id-r1-audit.json`.
The report preserves the original failed identity checks and the $1.29028 consumed across the three trials.
The runner checks for this contradiction after staging and refuses a new contestant while it persists.

Of the 25 contestants, eight passed, three failed the recorded checks, three encountered the invalid fixture and eleven await cross-vendor judgment.
The seven Codex judging sessions bring the measured API-equivalent total to $5.60598.
The measured solo lead gives no basis for estimating child usage in a team trial.

The 800,000-input stop barred the next solo spec-lead trial after 766,704 input and 25,610 output tokens.
Its same-case estimate was 196,796 input and 8,471 output, with 33,296 input and 94,390 output remaining.
No Sonnet judge ran on a Codex submission.
A deterministic failure is a failed trial even if its judge was barred.
A submission that passed deterministic checks and still needed a judge is recorded as unjudged.
The two terms `launch` and `access` also occurred as ordinary verbs in vendor instructions during the negative-only probes.
Neither appeared as a listed or loaded personal source.
The report distinguishes actual completed trials, refusals before launch and budget stops.

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
| #19 | Open after one named solo trial, pending remaining spec-lead trials and their judges |
| #20 | Closed with fresh eligible launch and refused-route controls for L promotion and M security, plus preservation of the original inputs |
| #21 | Closed after confirming the distinct collector error now survives the supervisor receipt and escalates before retry, store acceptance or gate 2 |
| #43 | Open for step 5 to prove the Claude builder command path |
| #44 | Open for step 9 to run paired disposable-login S1, system S3, S7 and S8 controls |

## Contract findings

The original tier-promotion fixture disclosed the intended classification and contradicted the blind method in `skills/_shared/evals.md`.
The coordinator approved the separately committed fixture correction recorded above.

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
