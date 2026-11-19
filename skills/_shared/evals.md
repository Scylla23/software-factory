# Eval cases

Each skill ships two or three eval cases in `<skill>/evals/evals.json`, with fixture files under `<skill>/evals/fixtures/`.
A case that has to be tried against more than one input does so through variants, so the count of cases stays at the plan's two or three while no failure scenario is dropped.
They are run in step 4b on `factory-pilot` tasks before a skill is trusted, and again after any edit to the skill.
Nothing here has been run yet.

## Shape of a case

| Field | Meaning |
|---|---|
| `id` | Stable id, `<skill>-<nn>-<slug>`. |
| `purpose` | The failure this case exists to catch. |
| `pilot` | What the `factory-pilot` repository must contain for the case, written so step 4b can bind it to a planted issue or plant one. `"self-contained"` means the fixtures are enough. |
| `input.brief` | The run brief fields that matter to the case; the runner fills the rest. For a team member (architect, infra, frontend, threat-modeler) the runner delivers it as the child run brief of `factory-contract.md` section 4, in the member's system prompt, with `reads` naming the staged files and `writes` the member's file in `outDir`. |
| `input.files` | Files to stage in the task folder (`taskDir`) before the run. Each key is a path under the task folder; each value is a fixture path under `evals/`, or `{ "inline": ... }` holding the content itself (JSON content is written as JSON). The runner computes `specSet` from the staged members of the spec file set and puts it in the brief. |
| `input.repo` | Optional, for cases that bring their own code: `{ "fixture": <path of a fixture repository>, "patch": <optional patch path inside it> }`. The runner writes every file under the fixture's `base/` into a fresh git repository with the `.txt` suffix removed and commits it as `baseSha`; with a patch it then runs `git apply` and commits the result as `headSha`, which is also checked out. See [evals/tasklist/README.md](evals/tasklist/README.md). |
| `answerKey` | Optional: the defects planted in the case's fixtures. It is for the runner and the judge and is never placed among the agent's inputs. |
| `expect` | Properties the output must have. Output paths are relative to the run's `outDir`. |
| `pass` | The rule that turns the checks into pass or fail. |
| `variants` | Optional: the inputs the case is tried against. Each variant has its own `id`, `input`, and `expect`, and may have `answerKey` and `pass`; the case then has no `input` of its own, and its `expect`, when present, applies to every variant as well. Each variant is run and judged as a case: three runs, all passing. |
| `controls` | Optional: canned responses the case must fail, listed below. |

## How a case is judged

Every `expect` item has a `kind`.

- `deterministic`: the runner checks it with code: schema validation, a field value, a file's existence, a regular expression, an exit code.
  These are written as an expression over the output so they need no interpretation.
- `judge`: a model from the other vendor than the one that ran the skill answers the check as a yes or no question and must quote the part of the output that supports its answer.
  The judge sees the fixtures, the output, and the check; it does not see the skill.
  A judge answer without a supporting quote counts as no.

A case passes when every deterministic check passes and every judge check is answered yes, unless its `pass` field says otherwise.
Run each case three times; a skill is trusted on a case only when all three runs pass, because a case that passes two times in three hides the failure it was written to catch.

A fixture that stands for an earlier stage's output, such as a previous verdict or build report, uses forty zeros for `baseSha` and forty ones for `headSha`.
The runner replaces them with the fixture repository's real commit ids before the run.
A `planSha256` of sixty-four zeros stands for the SHA-256 of the case's `verification/plan.json` after that replacement.
Any other placeholder value is left alone, which is how a case plants stale evidence.

A `specSetSha256` of sixty-four zeros stands for the hash of the case's staged spec file set, computed as the run contract defines.

A case built on planted defects lists them in `answerKey`, and its checks are written against that list: a reviewer must find each planted defect and must not block on a clean fixture.
The clean cases matter as much as the planted ones, because a reviewer that blocks everything also passes every planted case.

## Keeping the trial blind

A case proves nothing if the agent can read the answer.

- The agent under test runs with the same closed-by-default reads as a real run.
  The factory checkout that holds `skills/*/evals/`, the fixture repository's README, its patches, and every `answerKey` is outside every readable root; the agent sees only the bundle, which has no `evals/` folder, and the repository the runner built from `base/` and the patch.
- The runner writes the fixture repository under a neutral name, and never passes a fixture or patch file name to the agent, since the names describe the defects.
- The runner fails any run whose event stream shows a read of a path under an `evals/` folder, and plants a token in `_shared/evals/` that must never appear in a run.
- The worked examples in the skills are deliberately from a different product (an expense tracker) than the fixture repository and the pilot (a task list), with different defects.
  An example that named a case's planted defect would turn the case into a copying test.

## Controls

A check that every response passes measures nothing, so a case can name canned responses that it must fail.
The runner scores each control with the case's own checks, without running a model, and the case is valid only if the control fails the checks named in `mustFail`.

| `response` | What the runner submits |
|---|---|
| `skill-example` | The JSON example from the skill's own `SKILL.md`, with `taskId`, the SHAs, and `specSetSha256` replaced by the run brief's. It shows that copying the example does not pass. |
| `fix-first` | Builder cases only: a scripted run that edits the production file first, then adds the tests, then reports a failing run in `reproduction`. It shows that a claimed red run is not enough. |

Some checks read the run's event stream, the harness's own record of tool calls in order, instead of the output.
That is how a builder case establishes that the reproduction really came first: the first edit to a production file must come after a run of the `AC-1` test that exited nonzero.
A check on the final worktree alone cannot tell that from a fix written first.
