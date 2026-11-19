# Eval cases

Each skill ships two to four eval cases in `<skill>/evals/evals.json`, with fixture files under `<skill>/evals/fixtures/`.
They are run in step 4b on `factory-pilot` tasks before a skill is trusted, and again after any edit to the skill.
Nothing here has been run yet.

## Shape of a case

| Field | Meaning |
|---|---|
| `id` | Stable id, `<skill>-<nn>-<slug>`. |
| `purpose` | The failure this case exists to catch. |
| `pilot` | What the `factory-pilot` repository must contain for the case, written so step 4b can bind it to a planted issue or plant one. `"self-contained"` means the fixtures are enough. |
| `input.brief` | The run brief fields that matter to the case; the runner fills the rest. |
| `input.files` | Files to place in the task folder before the run. Each key is a path under the task folder; each value is a fixture path under `evals/`, or `{ "inline": ... }` holding the content itself (JSON content is written as JSON). |
| `input.repo` | Optional, for cases that bring their own code: `{ "fixture": <path of a fixture repository>, "patch": <optional patch path inside it> }`. The runner writes every file under the fixture's `base/` into a fresh git repository with the `.txt` suffix removed and commits it as `baseSha`; with a patch it then runs `git apply` and commits the result as `headSha`, which is also checked out. See [evals/tasklist/README.md](evals/tasklist/README.md). |
| `answerKey` | Optional: the defects planted in the case's fixtures. It is for the runner and the judge and is never placed among the agent's inputs. |
| `expect` | Properties the output must have. |
| `pass` | The rule that turns the checks into pass or fail. |

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

A case built on planted defects lists them in `answerKey`, and its checks are written against that list: a reviewer must find each planted defect and must not block on a clean fixture.
The clean cases matter as much as the planted ones, because a reviewer that blocks everything also passes every planted case.
