# Software Factory

Software Factory takes an owner-authorized GitHub issue in a registered pilot repo and turns it into a reviewed, verified pull request.
The owner approves the spec, approves the verified commit, and merges the PR.

## Pipeline

```text
GitHub issue -> Triage -> Spec lead -> Owner spec gate
  -> Codex builder -> Checks -> Claude code review -> Browser verification
  -> Owner approves verified head -> Owner merges
```

- **Triage and spec**
  Intake checks the issue author and the owner's `factory` label on the current issue revision.
  Triage records scope and risk, then the spec lead writes acceptance criteria and the factory publishes them in a draft PR.
- **Spec gate**
  The owner posts `/approve <spec-sha>` to authorize that revision or `/respec <feedback>` to ask for a new one.
- **Build and check**
  Codex gets an Orca worktree and a reproduce-first builder contract.
  The factory checks that the same test fails for the approved reason on base and passes on head, then requires the registered project checks to pass.
- **Review and repair**
  Claude reviews the tested commit against the approved spec and reproduction evidence.
  The factory allows one automated repair for a failed check, a blocking review, or a behavioral verification failure, then checks and reviews the new commit. [Stage driver](src/factory/run.ts)
- **Verify and hand off**
  The factory runs base and head previews in macOS sandboxes and captures desktop, mobile, and API evidence in an isolated Orca browser profile.
  The App publishes the evidence and marks the PR ready.
  The final gate records an owner approval submitted after readiness and tied to the verified head SHA.
- **Record usage**
  The factory stores token usage, API-equivalent cost estimates, and coverage by attempt.
  Run `bun run factory cost --by task` to inspect the records. [Usage accounting](docs/steps/08-usage-cost.md)

## Harness engineering

- **Role contracts**
  Each dispatched skill gets a pinned bundle, a run brief, and scoped tools and file access.
  The collector validates structured output and binds the submitted bytes to the task, attempt, role, and harness session before the controller can use them. [Skill wiring](docs/steps/04b-skills-wiring.md#implemented)
- **Crash recovery**
  SQLite records intent before external effects, and the supervisor writes attempt-specific receipts for recovery.
  The crash test sends real `SIGKILL`s to the normal stage driver and checks that each simulated external resource and accepted approval is recorded once. [Crash test](test/factory-crash.test.ts#L22)
- **Blind evals**
  Contestants get staged inputs with answer keys held back.
  Deterministic checks verify properties such as schemas and test results, and a judge from the other model vendor must quote supporting evidence from the frozen output.
  The recorded batch had 44 variants, with 26 passes, four repeated failures, one missing submission, and 13 deferred. [Eval contract](skills/_shared/evals.md) and [results](docs/steps/04b-skills-wiring.md#final-eval-results)
- **Judge calibration**
  A planted security defect exposed a judge rubric that rejected valid line citations.
  After the rubric was corrected, both frozen submissions passed rejudgment, with the original failures retained in the receipts. [Rubric correction](docs/steps/04b-skills-wiring.md#repeated-failures)
- **Mutation testing**
  The recorded final run caught 68 of 68 pipeline mutants, 79 of 79 skill-wiring mutants, and 48 of 48 usage-accounting mutants. [Mutation results](docs/steps/04b-skills-wiring.md#final-verification-on-the-factory-branch)

## Pilot results

- The first run fixed an inventory row that displayed a measured zero as `Uncounted`.
  The owner approved the verified commit and merged the PR. [First pilot writeup](docs/steps/03-walking-skeleton.md#gate-2)
- The second run fixed a stock column mislabeled `Price`.
  The factory completed both owner gates with 24 passing verification checks and six captures.
  The PR remains open against the pilot seed. [Second pilot writeup](docs/steps/04b-skills-wiring.md#live-pilot-completion)
- The second run recorded $0.87 in API-equivalent model cost, rounded from the Claude and Codex receipts. [Pilot cost records](docs/steps/04b-skills-wiring.md#live-pilot-completion) and [pricing assumptions](docs/steps/08-usage-cost.md#prices-and-assumptions)

## Status and limits

The CLI runs or resumes an issue on demand with `bun run factory run <issue-url>`.
The implementation targets a single owner-controlled pilot repo.
`factory.config.ts` hardcodes the owner identity, pilot registration, project commands, and local Orca, Bun, and Node layout. [Configuration](factory.config.ts)
The sandbox uses macOS `sandbox-exec`, and the browser uses an isolated profile with unrestricted browser egress. [Browser evidence](src/verify/browser.ts) and [trust model](docs/testing-policy.md#threat-model)
The daemon, automated spec review, dynamic tier routing, free-text intake, general project adapter, and runtime auditor dispatch are planned. [Design](docs/design.md) and [plan](docs/v1-plan.md)

## Run the tests

Use macOS with `sandbox-exec`, Git, and the pinned Bun version. [Bun pin](.bun-version)
Run from a checkout outside the system temp directory so the sandbox fixtures can create valid state roots.

```sh
bun install --frozen-lockfile
scripts/test-watchdog.sh
bun run typecheck
```

The watchdog runs `bun test` with a wall-clock limit and records any leftover processes.
Live runs additionally need Orca, Codex CLI, Claude Code, authenticated factory harness homes, the configured pilot checkout and Node toolchain, and an installed GitHub App with its key in macOS Keychain. [Dispatch setup](src/dispatch/config.ts) and [App credentials](src/github/app.ts)

## Repo map

- [`src/`](src/) contains the stage driver, dispatch, GitHub publishing, verification, and usage accounting.
- [`skills/`](skills/) contains role instructions, schemas, and eval fixtures.
- [`scripts/`](scripts/) contains eval runners, probes, mutation tests, and the test watchdog.
- [`docs/`](docs/) contains the design, testing policy, and run reports.
- [`test/`](test/) contains the Bun suite and captured fixtures.
