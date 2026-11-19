# Step 8 - Usage and cost

Run `bun run factory cost --by task` to see measured tokens, API-equivalent USD estimates, model discrepancies and improvement signals.
The other grouping keys are `project`, `model` and `stage`.
`bun run factory status` adds the same token and cost columns to each task.
Both commands open the database read-only and report from one SQLite snapshot.

## Accounting

Dispatch parses Claude's result and Codex's `turn.completed` events at exit.
The meter prefers Claude's `total_cost_usd` for the run and records the individual `modelUsage` entries for model reporting.
For a multi-model run, the model report uses the amounts attributed to each model by the CLI, while the task, project and stage reports use the run total.
Codex input includes cache hits and writes, so the meter subtracts both before pricing ordinary input.
Output already includes reasoning.
The normalized line records reasoning separately when the harness provides it.

When exit accounting is absent, the meter reads only the named session under the factory's dedicated Claude or Codex home.
For Claude, the dispatch UUID also identifies a session that died before emitting its init event.
Claude message IDs deduplicate fragments across the main transcript and its own subagent directory.
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
An interrupted supervisor leaves an uncertain audit that a final receipt can settle once.
The migration prices historical v1 result rows using the dated table and preserves missing measurements.
The read-only commands can also display those rows before migration.

The cost report links repeated attempt IDs, escalation transitions, owner gate comments, reviews and inline review comments.
The controller saves owner-authored review text and its ID at gate 2.
Publication tests inspect the actual commit request for the `Factory-Task` and `Factory-Agent` trailers on both a spec commit and a build commit.

## Prices and assumptions

The table uses the vendors' Standard API rates checked on 2026-11-20 in the owner's time zone.
The factory pays for subscriptions, so all USD figures are API-equivalent estimates.
Every entry in [prices.ts](../../src/usage/prices.ts) has its source URL.

| Model | Ordinary input | Cache hit | Short write | Long write | Output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude Opus 5.5 | 4 | 0.20 | 5 | 8 | 20 |
| Claude Haiku 5.5 | 0.10 | 0.01 | 0.125 | 0.20 | 0.50 |
| GPT-6.2 Sol | 2 | 0.10 | 2.50 | 5 | 10 |
| GPT-6 Luna | 0.10 | 0.01 | 0.125 | 0.25 | 0.50 |

Amounts are USD per million tokens at short-context rates.
Claude fallback applies the 5-minute and 1-hour write rates to the transcript split and applies the Haiku long-context rate above 100,000 prompt tokens. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
Codex's aggregate result lacks per-request prompt lengths and cache-retention splits.
The proposed reporting convention prices that aggregate at Standard short-context and 30-minute write rates.
For individually recovered Codex responses above 272,000 input tokens the meter applies the documented long-context multipliers. [GPT-6.2 Sol pricing](https://developers.openai.com/api/docs/models/gpt-6.2-sol) and [GPT-6 Luna pricing](https://developers.openai.com/api/docs/models/gpt-6-luna)
The design calls for an estimate without specifying a tier or how to handle missing retention data.
Preserving the price date in each capture makes that assumption auditable.

## Live proof

The four fixture sessions ran at low effort through `runAgent` in isolated read-only Orca worktrees using the factory harness homes.
The complete prompt asked for the single word PELICAN with no tools.
For interrupted sessions the prompt requested a 60-second sleep through Bash.
Claude was cancelled immediately after the first assistant event and exited 143.
Codex timed out at 25 seconds and terminated with SIGTERM.
Both interrupted runs lacked final result usage and both worktrees cleared the dispatch cleanup check.
The [fixtures](../../test/fixtures/usage) retain allowlisted event and usage fields, with prompts, tool contents, installation metadata, paths and account data removed.

| Harness and source | Ordinary input | Cache read | Cache write | Output | Total tokens | API-equivalent USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude Haiku full result | 2 | 5,427 | 6,812 | 7 | 12,248 | 0.00142037 |
| Claude Haiku interrupted transcript, partial | 2 | 7,216 | 5,038 | 82 | 12,338 | 0.00112096 |
| Codex Luna full result | 10,658 | 0 | 0 | 7 | 10,665 | 0.00106930 |
| Codex Luna interrupted rollout, partial | 10,660 | 0 | 0 | 36 | 10,696 | 0.00108400 |

On the completed Codex run, exit usage gave 10,658 input and 7 output tokens, and the rollout's independent `token_usage_record.usage.total_tokens` was 10,665.
The delta was zero tokens.
The completed Claude transcript also reproduced all four CLI token buckets and its reported USD total to floating-point precision.
The restricted Claude tool list excludes the native Agent tool, so the child-history regression uses the real cancelled message in a constructed parent and child layout.
No live subagent was launched.

## Verification

`bun run typecheck` passed.
`python3 scripts/mutate-step-08.py` ran each affected test against the baseline, applied one change at a time in a private source copy, and required the named test to fail.
All 19 [mutants](../../scripts/mutations/step-08.json) were killed, covering message and response deduplication, session ownership, unknown cost, prices, token subsets, reported totals, coverage, receipt adoption and feedback attribution.
