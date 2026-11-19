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

The worker still uses the step 3 prompts.
The role definitions and policy builders are available for proofs, but no production skill dispatch path has been enabled.
The store migration, staging, worker integration and acceptance joins are outstanding.

## Pinned harness results

The installed versions are Claude Code 2.1.325 and Codex CLI 0.169.0.
The Codex runs below used `gpt-6-luna` at low effort with fresh account and harness homes.
The probe removes its fixture and copied factory login after it collects the observations.
Run `bun scripts/probe-step-04b.ts` with the test name to reproduce a row.

| Proof | Result | Evidence |
| --- | --- | --- |
| Codex D1 delivery channel | Passed for the probe instruction | Parent thread `01a1f586-ebbc-7851-8201-e0deede838d2` recorded the random marker in a developer message and returned it |
| Codex D2 | Passed | Thread `01a1f586-ebb8-7893-98ef-9c279f0920dc` recorded the resource path and returned its fresh marker |
| Codex A1, fact 15 | Verified | Thread `01a1f587-15ff-7401-ac4d-b25a6e0c5f9a` exposed no spawn tool and had no child, while control `01a1f586-ebd7-7c03-84d4-1aa4b7e3c132` exposed it and started child `01a1f586-ffb4-71d2-8b03-78c938c23842` |
| Codex R1 | Incomplete | Direct sandbox invocation refused the fixture file with EPERM, though the live positive arm read it, but the negative model run supplied no completed read command and the separate file-tool control is outstanding |
| Codex R2 | Passed on the dependency-free fixture | Thread `01a1f586-ec40-7581-a0fa-c17ee831267a` ran the Bun test in the scratch checkout, Git diff and show in the snapshot, and read the bundle marker |
| Codex native output | Passed for a new file | Thread `01a1f588-dba5-7f41-a50e-5524d971e0a4` produced a completed native `FileChange` with the exact submitted content including the newline, and the adapter's digest matched the independent expected bytes |
| Claude D1 under `--agent spec-lead` | Blocked before inference | The isolated invocation exited 1 with `Not logged in`, and the dedicated factory home reports logged in only with the ordinary account home |

The scope of the native write proof is one complete addition.
The existing exec stdout item exposes the path, kind and status.
The protected Codex rollout supplies the content through `event_msg.item_completed.item` with type `FileChange`.
Neither arbitrary command output nor the model's final message supplies a receipt.

Facts 6b and 6c require Claude A2 and A3 with a functioning disposable login.
Fact 7 requires the Claude worktree discovery controls.
Facts 13a, 13b and 14 require the separate Codex custom definition, project definition and child discovery controls.
These facts remain unverified.
D3-D6, S1-S8, A2-A4, the native file-tool arm of R1 and live R3 remain incomplete.
The deterministic bundle exclusion and collector tests cover only parts of D5 and R3.

## Validator and regression tests

`bun scripts/validate-skills.cjs` reproduces the step 4a review's 221 checks using Ajv 8.20.0.
The 63 schema-rejection mutations must fail schema validation.
The 41 join-control documents must remain schema-valid so their owning stages can exercise the corresponding semantic joins.
Passing those 41 controls establishes no runtime joins.

The collector test uses the archived `changes` verdict and the `review-approve` base for the same fixture.
Both documents pass the verdict schema.
The collector accepts the authentic bytes and rejects the replacement against the authentic receipt.
This is a factory-side control.
Live process teardown and child authorship still require separate proofs.

`python3 scripts/mutate-step-04b.py` killed 19 of 19 implementation mutants.
Two development suites passed with 331 and 342 tests respectively.
Typecheck and the focused run brief tests passed after the second suite.
The 20-run final sequence awaits finished integration.

## Skill evals

| Skill | Blind eval result |
| --- | --- |
| Triage | Pending |
| Spec lead | Pending isolated Claude lead and team proofs |
| Architect | Pending authenticated child launch |
| Infra | Pending authenticated child launch |
| Frontend | Pending authenticated child launch |
| Threat modeler | Pending authenticated child launch |
| Spec reviewer | Pending verified dispatch |
| Builder | Pending verified dispatch |
| Code reviewer | Pending verified dispatch |
| Security auditor | Pending verified dispatch |
| Database auditor | Pending verified dispatch |
| Verifier | Pending verified dispatch |

Claude production evals and the end-to-end pilot have not run.

## Open issues

| Issue | Status |
| --- | --- |
| #15 | Open pending complete per-harness author receipts, cleanup and live collection through the store |
| #16 | Closed after restoring the review validator and reproducing its 221 checks |
| #17 | Open pending the remaining pinned proof matrix |
| #18 | Open pending both arms of R1 and integration of the verified profile or broker |
| #19 | Open pending isolated Claude authentication, D1 and authorized blind evals |
| #20 | Open pending the fresh eligible launch path and its controls, with the escalation path covered |
| #21 | Open pending propagation of the distinct collector error through the worker and persistence boundary |

## Contract findings

Disposable Claude authentication is a prerequisite for source-specific discovery controls.
Copying the factory account's non-secret login metadata into a fresh configuration did not establish a login.
Using the shared subscription home for these controls would invalidate the isolation claim.

The job driver still needs a checked route from the step 3 task and persisted outputs into the complete skill inputs.
In particular, the step 3 spec stage has no stored triage result, and the reviewer consumes a free-text rationale while the skill emits a structured verdict.
Any production transition must keep the existing owner gates and independent base and head checks intact.
