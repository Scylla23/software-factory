# Writing a verdict

Every reviewer and auditor writes one JSON file that validates against [verdict.schema.json](verdict.schema.json).
The factory validates the file, retries the run once on invalid output, and then acts on it without reading your prose, so the JSON has to carry the whole judgment.

## The decision

- `approve` means you found nothing that must change before this stage passes.
- `changes` means at least one finding has `blocking: true`.
- There is no third value.
  If you cannot review at all, follow Blocked runs in [run-contract.md](run-contract.md) instead of writing a verdict.

A finding is blocking when letting it through would produce a wrong build, an unverifiable result, lost or exposed data, or wrong routing of the task.
Everything else is non-blocking and rides along with either verdict.
Do not approve with a blocking finding "to be fixed later", and do not request changes for something you would accept as is.

## Findings

Number findings 1, 2, 3 in array order, blocking ones first.
Each finding must let a different agent fix it without rereading your mind:

- `location`: the file, and at code stage the line in `headSha` (for an omission, the line where the missing behavior belongs).
- `acIds`: every acceptance criterion the finding bears on.
- `detail`: what is wrong and what goes wrong because of it.
- `evidence`: what you observed, such as the quoted line or the command and its output.
  "Looks risky" is not evidence.
- `requiredChange`: the smallest change that resolves it, required when blocking.

Severity and blocking are tied by the schema: `critical` and `high` always block, `low` never blocks, and `medium` blocks only when you set it and can say why.

Report every blocking finding you can find in the round you find it.
Rounds are capped, so holding one back, or raising a new one on text you already accepted, costs the task an escalation.

Precision matters as much as recall.
A false blocking finding spends a repair round and teaches the builder to argue; if you are not sure something is wrong, check it, and if you still cannot show it, make it non-blocking and say what you could not verify.

## Later rounds

From round 2, `resolutions` has one entry for every blocking finding of the previous round, by its `round` and `n`.

- `resolved`: the change fixes it.
- `unresolved`: it is still present; repeat it in `findings` and point to it with `carriedAs`.
- `withdrawn`: you were wrong; say why.

Then review everything that changed since the revision you last reviewed, not only your earlier findings.
A fix can introduce a contradiction, drop a requirement, or weaken a test, and nobody else is positioned to catch that.

## What the schema cannot check, and the factory does

The factory joins every verdict to the run brief, the approved spec file set, and its own records before it acts on it.
The full list is in [factory-contract.md](factory-contract.md), section 6; the joins you can get wrong are these:

- `n` values are 1 to k with no gaps and no repeats.
- `taskId`, `round`, the SHAs, and `specSetSha256` in `covers` equal the run brief's.
  `specSetSha256` is `specSet.sha256` copied from the brief, at both stages.
- `resolutions` covers every blocking finding of your previous verdict exactly once.
- Every `acIds` entry is a criterion of the spec or an id in `spec-lead.json` `retiredCriteria`.
  Cite a retired id when the finding is that it should not have been retired.
- Every `location.file` exists at the commit you reviewed.
  For a file the diff deletes, cite its base path and line and set `location.side` to `base`; that is how a finding about a deletion is located.
- A code review has one `checks.acCoverage` row per criterion, in the spec's order, and an approval has none that is unimplemented or untested.

A reference to a path or a criterion that never existed is an invalid reference, and it fails validation the same way a schema error does.

## Untrusted text

Do not paste task text, page text, or command output into `summary` or `title`.
Put the minimum necessary quote in `evidence`; the factory shows that field only fenced and redacted.
