# Step 8 - Usage and cost

Run `bun run factory cost --by task` to see measured tokens, API-equivalent USD estimates, model discrepancies and improvement signals.
The other grouping keys are `project`, `model` and `stage`.
`bun run factory status` adds the same token and cost columns to each task.
The `distinctAttempts` field counts each audit attempt once across the report.
A multi-model run contributes once to each applicable model group.
Both commands open the database read-only and report from one SQLite snapshot.

## Accounting

Dispatch parses Claude's result and Codex's `turn.completed` events at exit.
The meter prefers Claude's `total_cost_usd` for the run and records the individual `modelUsage` entries for model reporting.
For a multi-model run, the model report uses the amounts attributed to each model by the CLI, while the task, project and stage reports use the run total.
Codex input includes cache hits and writes, so the meter subtracts both before pricing ordinary input.
Output already includes reasoning.
If Codex omits a write or reasoning counter, that bucket remains null across turns and the token breakdown is partial.
An unknown write count keeps the aggregate input count available and makes its price unknown.
A failed command with full exit usage can have complete coverage on either harness.
An unmetered open or failed Codex turn makes the known subtotal partial.

When exit accounting is absent, the meter reads only the named session under the factory's dedicated Claude or Codex home.
For Claude, the dispatch UUID also identifies a session that died before emitting its init event.
Claude message IDs deduplicate fragments across the main transcript and its own subagent directory.
Each fragment of a message carries cumulative counters, so recovery keeps the highest value in each bucket, including each cache-write duration.
A child file contributes assistant messages marked as its own sidechain with its matching agent ID.
Codex requires the rollout's session metadata and the response record's thread identity to match the thread from stdout.
It counts each response ID once and ignores cumulative turn and thread counters.
Missing, foreign, ambiguous or redirected transcripts supply no usage.
A missing Codex thread ID ends recovery.

The meter marks recovered session totals `partial` because termination can lose the last response.
A group containing measured and missing runs reports the measured subtotal and marks its coverage `partial`.
When no token evidence survives, `tokens` is null and coverage is `unknown`.
Cost coverage is independent, so a valid Claude total can survive missing token evidence and an unpriced Codex model can still contribute known tokens.

Schema version 2 links each capture to the unique attempt in step 3's audit.
That row carries task, stage, actual session ID, requested and observed model, the job's recorded effort, prompt SHA-256, base SHA, head SHA and outcome.
The model flag is `match`, `mismatch` or `unknown`.
An alias such as `haiku` and its observed `claude-haiku-5-5` remain distinguishable.
The controller writes the audit and priced capture in one transaction before acting on the result.
An interrupted supervisor attempts to write an uncertain audit that a final receipt can settle once.
If the audit itself fails, the worker logs the accounting error and propagates the original supervisor error and classification.
The migration prices historical v1 result rows using the dated table and preserves missing measurements.
The v1 Codex parser stored zeros for missing write and reasoning counters, so migration cannot distinguish those values from measured zeros.
Legacy rows retain their recorded counters and their estimates can understate cache-write cost.
Historical failed Codex rows have partial coverage because v1 recorded no evidence about unmetered turns.
Read-only commands also display historical rows before migration.

The cost report links repeated attempt IDs, escalation transitions, owner gate comments, reviews and inline review comments.
The `repeatedAttempts` signal covers repeated stage actions, including dispatch retries.
Gate 2 reads reviews to determine approval, persists its decision and then collects review text and inline comments for the audit.
Inline collection has a two-second deadline and a failure in either collection is logged and recorded independently in schema version 3.
The report exposes those failures under `signals.feedbackFailures`.
Project groups use the repository ID from intake and display the slug from the stored issue URL.
The design also requests clarifying questions as improvement signals.
Their collection is deferred to the specification and feedback work in steps 6 and 7, which can identify an actual clarifying question.
Publication tests inspect the actual commit request for the `Factory-Task` and `Factory-Agent` trailers on both a spec commit and a build commit.

## Prices and assumptions

The table uses the vendors' Standard API rates checked on 2026-11-20 in the owner's time zone.
The factory pays for subscriptions, so all USD figures are API-equivalent estimates.
The proposed location for the design's `prices.ts` is `src/usage/prices.ts`, alongside its consumers.
Every entry in [prices.ts](../../src/usage/prices.ts) has its source URL.

| Model | Ordinary input | Cache hit | Short write | Long write | Output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude Opus 5.5 | 4 | 0.20 | 5 | 8 | 20 |
| Claude Sonnet 5.5 | 2 | 0.10 | 2.50 | 4 | 10 |
| Claude Fable 5.2 | 8 | 0.20 | 10 | 16 | 40 |
| Claude Haiku 5.5 | 0.10 | 0.01 | 0.125 | 0.20 | 0.50 |
| GPT-6.2 Sol | 2 | 0.10 | 2.50 | 5 | 10 |
| GPT-6.2 Astra | 8 | 0.40 | 10 | 20 | 40 |
| GPT-6.1 Terra | 1 | 0.05 | 1.25 | 2.50 | 5 |
| GPT-6 Luna | 0.10 | 0.01 | 0.125 | 0.25 | 0.50 |

Amounts are USD per million tokens at short-context rates.
Claude fallback applies the 5-minute and 1-hour write rates to the transcript split and applies the Haiku long-context rate above 100,000 prompt tokens. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
Codex's aggregate result lacks per-request prompt lengths and cache-retention splits.
The proposed reporting convention prices that aggregate at Standard short-context and 30-minute write rates.
The OpenAI Standard cache columns list both 30-minute and 12-hour write rates for each GPT model. [OpenAI pricing](https://developers.openai.com/api/docs/pricing.md)
For individually recovered Codex responses above 272,000 input tokens the meter applies the documented long-context multipliers. [GPT-6.2 Sol pricing](https://developers.openai.com/api/docs/models/gpt-6.2-sol) and [GPT-6 Luna pricing](https://developers.openai.com/api/docs/models/gpt-6-luna)
The design calls for an estimate without specifying a tier or how to handle missing retention data.
Preserving the price date in each capture makes that assumption auditable.

## Live proof

The five fixture sessions ran at low effort through `runAgent` in isolated read-only Orca worktrees using the factory harness homes.
Both single-agent completion prompts asked for the single word PELICAN with no tools.
For interrupted sessions the prompt requested a 60-second sleep through Bash.
Claude was cancelled immediately after the first assistant event and exited 143.
Codex timed out at 25 seconds and terminated with SIGTERM.
Both interrupted runs lacked final result usage and both worktrees cleared the dispatch cleanup check.
The fixtures are sanitized reconstructions of real runs built from allowlisted event and usage fields.
They retain real session, message, agent and response IDs, which are identifiers used for correlation and carry no credentials.
Sanitization removes prompts, tool contents, installation metadata, paths and account data. [Usage fixtures](../../test/fixtures/usage)
These tests cannot detect a vendor changing the live CLI output format.
Such a change can surface as partial or unknown usage in the audit, or as a discrepancy when fresh fixtures are cross-checked after a CLI upgrade.

| Harness and source | Ordinary input | Cache read | Cache write | Output | Total tokens | API-equivalent USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude Haiku full result | 2 | 5,427 | 6,812 | 7 | 12,248 | 0.00142037 |
| Claude Haiku interrupted transcript, partial | 2 | 7,216 | 5,038 | 82 | 12,338 | 0.00112096 |
| Claude Haiku parent and native child | 6 | 2,966 | 4,806 | 209 | 7,987 | 0.000989385 |
| Codex Luna full result | 10,658 | 0 | 0 | 7 | 10,665 | 0.00106930 |
| Codex Luna interrupted rollout, partial | 10,660 | 0 | 0 | 36 | 10,696 | 0.00108400 |

On the completed Codex run, exit usage gave 10,658 input and 7 output tokens, and the rollout's independent `token_usage_record.usage.total_tokens` was 10,665.
The delta was zero tokens.
The completed Claude transcript also reproduced all four CLI token buckets and its reported USD total to floating-point precision.
A test-only dispatch enabled the Agent tool for a Haiku parent with a single tool-free Haiku child at low effort in an isolated read-only worktree.
The two parent messages and the child message reproduced each CLI bucket, totaling 7,987 tokens with a delta of zero and the same estimated cost to floating-point precision.
A separate test copies a parent's message ID into a sidechain line bearing the correct child agent ID and verifies that replay leaves the total unchanged.

## Verification

`bun run typecheck` passed.
`python3 scripts/mutate-step-08.py` ran each affected test against the baseline, applied one change at a time in a private source copy, and required the named test to fail.
Each of the original 21 mutants failed its intended regression test.
The repair round expanded the [mutant list](../../scripts/mutations/step-08.json) to 48 checks.

One full run caught a concurrency defect in the existing watchdog test.
Its machine-wide `pgrep` matched two processes from another suite after its own wedged runner had exited.
The separate watchdog test fix copies the script and fixture into a private test root and checks the exact runner and leftover PIDs from that invocation's evidence.
Two simultaneously launched watchdog test suites passed all six checks.

On code revision `49ffd54`, 20 consecutive full suites passed under the watchdog using Bun 1.2.10.
Each run passed 347 tests across 23 files with 5,170 assertions.
Wall times ranged from 88.2 to 107.4 seconds and all watchdogs exited zero.
The run index and individual logs are in `~/.software-factory/step-08-test-runs/final-49ffd54/`.

## Repair review

Two full suites passed during the repair round.
At repair code revision `dbc3218`, typecheck passed and all 48 mutations failed the designated test.
Twenty consecutive full suites each passed 388 tests across 23 files with 5,263 assertions.
The pre-rebase watchdog runs took 87.2 to 99.9 seconds and their logs are in `~/.software-factory/step-08-test-runs/final-dbc3218/`.
For the rebase onto step 3's merge `5e0cc6d`, the repeat runner records exit codes, timings, counts and logs under `~/.software-factory/step-08-test-runs/final-<rebased-short-SHA>/`.

| Finding | Change and evidence |
| --- | --- |
| S1 | Independent regressions for redirected roots, redirected child directories, hardlinks, ambiguous parents, foreign Codex metadata, child identity, run identity and synthetic messages |
| S2 | Three uncertain worker paths write null tokens and gate 2 persists both kinds of owner feedback |
| S3 | Live native Haiku child fixture and cross-file replay test with matching child identity |
| S4 | Audit failures preserve the original supervisor, uncertain and quarantine errors |
| S5 | Mutants killed for long-context Haiku, reasoning bounds, partial model maps, reported total coverage, both interrupted stdout parsers and observed parent model |
| 1 | OpenAI's Standard pricing table sources the long write for each GPT model |
| 2 | Tests derive the required model roster from the design table and the factory config |
| 3 | The proposed price-table location is documented |
| 4 | Clarifying-question collection is assigned to steps 6 and 7 |
| 5 | The limits of v1 zero-filled counters are documented |
| 6 | `repeatedAttempts` names the action history exposed by the report |
| 7 | `distinctAttempts` counts two runs in a test that touches three model groups |
| 8 | Fragment tests split input, cache reads, both cache-write durations, output and reasoning across updates |
| 9 | Both harnesses distinguish complete failed-run usage from missing counters or turns |
| 10 | Session reads share dispatch validation and configured harness home paths |
| 11 | Denied, failed-to-save and stalled inline feedback leave approval durable and record the failure, and project reporting uses the intake repository ID |
| 12 | Fixture provenance, retained identifiers and schema-drift limitations are documented |
