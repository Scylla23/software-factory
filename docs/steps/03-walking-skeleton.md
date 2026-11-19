# Step 3 - Walking skeleton

The factory takes a GitHub issue from owner-authorized intake to an App-published pull request.
Run `bun run factory run <issue-url>` to advance or resume it, and `bun run factory status` to read the local state.
Each invocation ends at an outstanding human gate.
The pilot uses the hand-written spec, builder, and reviewer prompts.
Skill delivery remains in step 4b.

## Pilot

The App published the Bun inventory sheet in [pilot PR #3](https://github.com/Scylla23/factory-pilot/pull/3).
The owner merged it at `bb4111571a0b36b2ec811ccd7e25ecd15d1f51ab`.
The owner applied the `factory` label to [issue #4](https://github.com/Scylla23/factory-pilot/issues/4).
Before the fix the API returned a measured zero for measuring tapes, but the corresponding inventory row displayed `Uncounted`.
The controls were bench vises at four and tool chests with a missing count.

## Crash recovery and spec gate

The controller was killed with SIGKILL immediately after the harness wrote its first event and again after GitHub created the draft, before the controller committed the PR result.
The probe preloaded a console observer into the ordinary CLI and killed only its own process when the named event arrived.
The following excerpts are from separate invocations of the same issue URL.

```text
dispatched edd8bb52-c97b-4cb0-91a4-c3078f9e0dd0
exit 137
recover-worker edd8bb52-c97b-4cb0-91a4-c3078f9e0dd0
draft-open 801f8f8f-f1f6-4519-8d1e-53db598ba983
exit 137
draft-open 801f8f8f-f1f6-4519-8d1e-53db598ba983
https://github.com/Scylla23/factory-pilot/pull/5  /approve 1d7db041de529b96df9e0e02e6d08ef7b49e8b68
```

The GitHub head filter returned exactly one pull request, [pilot PR #5](https://github.com/Scylla23/factory-pilot/pull/5).
The completed Opus session ID matched the persisted worker attempt ID.
An earlier startup failed because the detached supervisor omitted the account name required by Claude's Keychain login lookup.
The retry preserved the failed audit row and launched with the account identity from the OS.

The owner requested a revision of the port requirement in [comment 7010423362](https://github.com/Scylla23/factory-pilot/pull/5#issuecomment-7010423362).
Haiku revised the spec to use the factory-assigned port for automation.
The stale and current commands were both issued after the revision, from owner ID `89606989`.

| Comment ID | Spec commit | Persisted decision |
| --- | --- | --- |
| 7016024393 | 1d7db041de529b96df9e0e02e6d08ef7b49e8b68 | Refused, stale SHA |
| 7016027636 | 67a7240421b9b8b90df050e819ec10702f7ed20d | Accepted once, released builder |

## Build and verification

The Codex builder produced the fix and a standalone regression test.
The factory copied only that test onto base and required an actual failing AC-1 assertion.
The first check run exposed a missing Node interpreter for the lint and typecheck entry points.
The factory declared the Node bin directory for its project sandbox, and the repair builder strengthened the regression test.
The automated repair allowance had then been consumed.

| Factory observation | Revision | Result |
| --- | --- | --- |
| `bun test ./repro.test.ts` | bb4111571a0b36b2ec811ccd7e25ecd15d1f51ab | Exit 1, AC-1 failed on the measuring tapes row |
| Same regression | e2569da8bfb3bc795e8e39b28713a6f3f1127863 | Exit 0, one pass and six assertions |
| `bun test` | e2569da8bfb3bc795e8e39b28713a6f3f1127863 | Four passed, zero failed |
| `bun run lint` and `bun run typecheck` | e2569da8bfb3bc795e8e39b28713a6f3f1127863 | Both exited zero |
| Opus code review | e2569da8bfb3bc795e8e39b28713a6f3f1127863 | Approved the rendered fallback and API and HTML controls |

Verification attempt `d42c6461-6029-4873-9726-b19fdee4e8d2` captured the base and reviewed head at desktop and mobile widths, plus both API responses.
The verifier expected whitespace between table cells, while the Orca reader returned one line per row with adjacent cells concatenated.
All four stock-count checks failed and the factory persisted `verifying -> escalated`.
The PR stayed draft and the App withheld the failed evidence summary.
The four original reader outputs, their commits, and screenshot hashes are in [the regression fixture](../../test/fixtures/pilot-inventory-captures.json).
The corrected check uses row boundaries and rejects missing, duplicate, or incorrect rows.

## Proposed design addition

The design specifies escalation after the repair budget is exhausted but leaves recovery from a defect in the factory verifier unspecified.
For step 3, the proposed owner command is `/reverify <reviewed-head-sha>` on the same PR after the App reports the escalation.
It authorizes a fresh verification attempt only when the stored escalation came from verification and the approved code-review verdict, task, and live PR still cover the same revision.
The factory requires the owner's numeric user ID, checks its own recorded comment IDs and hidden marker, and consumes each comment ID once.
The repair count carries forward, and the normal GitHub review on the verified head remains required at gate 2.
Failed evidence is retained alongside subsequent attempts.

## Factory tests

The SQLite crash test launches the ordinary stage driver in subprocesses using a fake dispatcher that records external attempts separately from the database.
It delivers 17 real SIGKILLs across the nine states on the success path, including after every simulated side effect and before its result commit.
Recovery finished with exactly eight completed attempts, eight external resources, two consumed approvals, and one transition per state.

An isolated source copy was tested with 35 single-rule mutations to intake, gates, attempt recovery, transitions, review parsing, and the browser reader.
All 35 were killed by their targeted tests.
Restoring the old whitespace-dependent reader failed each of the four saved-capture tests.
