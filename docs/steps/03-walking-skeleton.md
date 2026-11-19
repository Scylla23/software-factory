# Step 3 - Walking skeleton

The factory takes a GitHub issue from owner-authorized intake to an App-published pull request.
Run `bun run factory run <issue-url>` to advance or resume it, and `bun run factory status` to read the local state.
Each invocation ends at an outstanding human gate.
The pilot uses the hand-written spec, builder, and reviewer prompts.
Skill delivery remains in step 4b.

## Implementation

The project registration, commands, toolchain locations, fixture, owner ID, and agent roles live in [factory.config.ts](../../factory.config.ts).
The controller serializes active runs with a process-held SQLite lock and persists state separately in `~/.software-factory/factory.sqlite`.
Task identity includes the source, GitHub repository ID, and issue ID.
Intake checks the issue author's numeric ID and the owner's latest application of the factory label against the last edit.
Before an external action the store commits an attempt UUID, task visit, action, and intended input.
A detached supervisor runs each model in an Orca worktree and leaves an attempt-specific receipt under the private state root.
On restart the controller adopts that receipt or waits for the existing supervisor, and escalates uncertain worker ownership.
The audit records the session, requested and observed models, effort, prompt hash, SHAs, usage, and outcome.
Only the publisher holds the App credentials.

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

```sh
pilot_issue=https://github.com/Scylla23/factory-pilot/issues/4
KILL_FACTORY_AT=dispatched bun --preload ./kill-event.ts src/factory/cli.ts run "$pilot_issue"
KILL_FACTORY_AT=draft-open bun --preload ./kill-event.ts src/factory/cli.ts run "$pilot_issue"
bun run factory run "$pilot_issue"
```

The temporary preload killed the controller using this hook.

```ts
const print = console.log;
console.log = (...args: unknown[]) => {
  print(...args);
  if (args[0] === process.env.KILL_FACTORY_AT) process.kill(process.pid, "SIGKILL");
};
```

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

The unit test planted a comment beginning with the exact approval command and carrying the App's hidden marker.
It also planted a marker-free comment whose ID belonged to the publisher.
Both were recorded as factory comments and refused even with the owner's user ID on the test input.
These cases ran locally and produced no GitHub comments.

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

The base-reproduction attempt `2586db24-7426-4be6-8851-0b205651a514` and head-check attempt `3fbb405a-7e0d-4e56-9f7d-a5c36449069d` recorded the following Bun output.

```text
base: bun test ./repro.test.ts
error: expect(received).toContain(expected)
Expected to contain: "<th scope=\"row\">Measuring tapes</th><td>0</td>"
(fail) AC-1 measured zero stock renders as 0 on the inventory sheet
 0 pass
 1 fail

head: bun test ./repro.test.ts
(pass) AC-1 measured zero stock renders as 0 on the inventory sheet
 1 pass
 0 fail
```

Verification attempt `d42c6461-6029-4873-9726-b19fdee4e8d2` captured the base and reviewed head at desktop and mobile widths, plus both API responses.
The verifier expected whitespace between table cells, while the Orca reader returned one line per row with adjacent cells concatenated.
All four stock-count checks failed and the factory persisted `verifying -> escalated`.
The PR stayed draft and the App withheld the failed evidence summary.
The four original reader outputs, their commits, and screenshot hashes are in [the regression fixture](../../test/fixtures/pilot-inventory-captures.json).
The corrected check uses row boundaries and rejects missing, duplicate, or incorrect rows.

The owner issued the same `/reverify` command twice.
The store consumed comment `7016572309` to resolve the escalation and recorded comment `7016928653` as its duplicate in the same SQLite transaction.
There was one new verification attempt, no new agent dispatch, and the repair count stayed at one.

```text
7016572309 | owner requested re-verification
7016928653 | duplicate of re-verification comment 7016572309
visit 12   | verify           | 7296985f-3a29-4671-a74c-11523d8a7e86
visit 13   | publish-evidence | 9113b0a8-5273-49be-bb07-880bfdd42eb0
visit 13   | mark-ready       | 1fb5c7fd-5e5b-4c1e-9cbb-7495d3c1c0ae
```

All 24 required checks passed on the new capture of the same reviewed head.
The App posted the [verification summary with six screenshot hashes](https://github.com/Scylla23/factory-pilot/pull/5#issuecomment-7016973776).
GitHub refused the ready-for-review mutation with pull-request write and contents read access.
The publisher used a repository-scoped token with contents write and pull-request write for that mutation, and GitHub returned the PR as open and ready at the verified head.
The separate summary token retained its narrower pull-request scope.

## Gate 2

The owner submitted [review 5980217577](https://github.com/Scylla23/factory-pilot/pull/5#pullrequestreview-5980217577) at 17:39:35 UTC.
GitHub returned `APPROVED`, user ID `89606989`, and the same full head SHA as the verified capture.

```text
bun run factory run https://github.com/Scylla23/factory-pilot/issues/4
{"id":1,"state":"done","pr":5,"head":"e2569da8bfb3bc795e8e39b28713a6f3f1127863","reason":""}

SQLite gate row and transition (UTC)
89606989 | review | 5980217577 | 1 | e2569da8bfb3bc795e8e39b28713a6f3f1127863 | approved verified head
14 | done | awaiting_pr_approval | 2026-11-19 17:40:56
```

The controller left PR #5 open for the owner to merge.

## Proposed owner commands

At gate 1, the proposed `/respec <feedback>` command asks the spec lead to revise the current draft on the same PR.
The new spec commit requires a fresh owner approval.
This extends the design's use of `/respec` after an issue edit.

The design specifies escalation after the repair budget is exhausted but leaves recovery from a defect in the factory verifier unspecified.
For step 3, the proposed owner command is `/reverify <reviewed-head-sha>` on the same PR after the App reports the escalation.
It authorizes a fresh verification attempt only when the stored escalation came from verification and the approved code-review verdict, task, and live PR still cover the same revision.
The factory requires the owner's numeric user ID, checks its own recorded comment IDs and hidden marker, and consumes each comment ID once.
The repair count carries forward, and the normal GitHub review on the verified head remains required at gate 2.
Failed evidence is retained alongside subsequent attempts.

If a read-only check or browser capture stops before writing its receipt, the App reports the exact interrupted attempt on its PR.
The proposed `/resume <attempt-id>` command records the owner's confirmation that the attempt's previews, port leases and browser profile have been torn down.
Preview directory names are the phase-specific IDs found in `project-logs/<attempt-id>/`, and a new browser capture uses a profile labeled `factory-verify-<attempt-id>-<uuid>`.
Before posting the command, stop the abandoned preview, remove its detached checkout and private preview home, release its lease, and close its isolated browser profile if one remains.
The controller checks the PR head, the comment's owner and edit history, the escalation's exact attempt, and the absence of that attempt's preview directories and leases.
It keeps the interrupted artifacts and the completed builder dispatch, then allocates a new UUID for the interrupted operation without consuming a repair or approving a gate.

The pilot's verifier supports the registered inventory criterion for issue #4.
General per-criterion evidence and screenshot publication belong in step 5 under Q56.
The skeleton checks exact revisions and stops on base drift or an edited intake revision.
The proposed follow-up is to handle rebase and owner-feedback recovery in step 6.
Step 3 uses the existing dispatch sandbox and a read-only reviewed worktree, with the closed-by-default agent read policy from Q57 scheduled for step 4b.

## Factory tests

The SQLite crash test launches the ordinary stage driver in subprocesses using a fake dispatcher that records external attempts separately from the database.
It delivers 17 real SIGKILLs across the nine states on the success path, including after every simulated side effect and before its result commit.
Recovery finished with exactly eight completed attempts, eight external resources, two consumed approvals, and one transition per state.

An isolated source copy was tested with 38 single-rule mutations to intake, gates, duplicate handling, attempt recovery, transitions, review parsing, and the browser reader.
All 38 were killed by their targeted tests.
Restoring the old whitespace-dependent reader failed each of the four saved-capture tests.

| Mutated behavior | Mutants detected |
| --- | ---: |
| Intake repository, owner, label actor and label chronology | 7 |
| Spec approval attribution, marker and revision | 4 |
| Reverification authority, escalation, SHA, duplicate and replay checks | 11 |
| Gate 2 review author, SHA, verdict and chronology | 4 |
| Stored attempt identity, visit, intent, approval and slot guards | 6 |
| Completed-attempt adoption and receipt persistence | 2 |
| Repair limit, evidence head and reviewer verdict parsing | 3 |
| Pilot inventory reader | 1 |

During full-suite repetition the project-instructions test failed once when the process descriptor count fell from 94 to 92 during an awaited rejection.
The corrected tests identify each newly open regular file by descriptor, device and inode, including a file already unlinked during cleanup.
Removing the reservation's close call in a local mutation made the partial-reservation test report both leaked descriptors.

On code revision `2c28031`, all 20 consecutive full suites passed under the project watchdog with 304 tests and 4,862 assertions per run.
Elapsed times ranged from 82.3 to 129.1 seconds, and the watchdog reported no leftover processes.
The local evidence directory is `~/.software-factory/step-03-test-runs/final-2c28031/`, with one log per run and a `results.txt` index.
Typecheck also passed.

```sh
for run in $(seq 1 20); do
  WATCHDOG_SECONDS=270 sh scripts/test-watchdog.sh || exit 1
done
bun run typecheck
```

## Open problems

The new store tests use in-memory databases and the subprocess crash test allocates a private directory per run.
The shared-state hang in concurrent suites remains open in [issue #11](https://github.com/Scylla23/software-factory/issues/11).
Bun 1.2.10's synchronous subprocess reentrancy remains tracked in [issue #10](https://github.com/Scylla23/software-factory/issues/10).
The Orca browser capture still has unrestricted egress, which the evidence comment discloses and [issue #13](https://github.com/Scylla23/software-factory/issues/13) tracks.
