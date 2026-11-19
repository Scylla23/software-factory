# Factory contract

[run-contract.md](run-contract.md) tells an agent what a run looks like.
This file tells the factory what it must enforce for that description to be true.
None of it is implemented by plan step 4a, which wrote the skills; each section names the plan step that owns it.
A skill may rely on a rule here only once the owning step has shipped it with the tests the section lists.

Nothing in this file is addressed to an agent.
It ships in the bundle so that an agent that wonders why an output was rejected can read the rule.

| Section | Owning step |
|---|---|
| 1. Attempt directories and write roots | 4b |
| 2. Closed-by-default reads, snapshots, scratch copies | 4b |
| 3. Agent types | 4b |
| 4. Child run briefs for the spec team | 4b generates them; 7 verifies authorship and order |
| 5. The spec file set, the review loop, and gate 1 | 6 |
| 6. Output joins | 4b for the shapes it wires; 5 for verification; 6 for verdicts |
| 7. Test integrity | 5 |
| 8. Builder checkouts, install, and resume | 5 for install; 6 for repair and budgets |
| 9. The evidence boundary | 5 |
| 10. Rebase | 6 |
| 11. Routing and gate 2 | 7 for routing; 5 and 6 for gate 2 |
| 12. Decision files copied into a project | 7 |

## 1. Attempt directories and write roots

Every run gets one attempt directory, created exclusively by the factory under a run root that is outside the state root, the project worktree, and every temp directory.

```text
<run root>/<attemptId>/
  skills/    read-only bundle                               skillsDir
  task/      read-only inputs, staged from the factory's store    taskDir
  out/       empty at start, the only place outputs are taken from    outDir
  scratch/   empty at start, deleted after the run          scratchDir
  snapshot/  read-only checkout, for every role but the builder   worktree
  scratch/repo/  disposable copy for code-stage reviewers and auditors   scratchRepo
  agents/    generated subagent definitions, spec lead only; read-denied to the agent's tools
```

Write roots, by role, are exactly the table in the run contract.
For both harnesses the sandbox policy is built from that table, not from one shared profile:

- The run root is write-denied as a whole, and `out/` and `scratch/` are the only writable carve-outs inside it.
  That keeps an agent from renaming, replacing, or deleting `task/`, `skills/`, `snapshot/`, or the attempt directory itself.
- For the builder the task worktree is writable and its git directories are not, as in step 1.
  For every other role no worktree is writable.
  `assertWorktreeWritable` in `src/dispatch/policy.ts` therefore becomes role-aware: it holds for the builder, and for other roles the policy must instead write-deny the snapshot.
  If a harness cannot start in a read-only directory, the process starts in `scratch/`; the brief's paths do not change.
- The file tools get the same limits as the shell: Edit and Write deny rules for Claude Code, and the profile's `read` entries for Codex.
  Codex needs explicit `write` entries for `out/` and `scratch/`, since both are outside its workspace.

Inputs are staged, never shared.
The factory keeps the canonical task files in its own store under the state root, where no agent can read or write, and copies the validated ones into `task/` for each run.
An agent therefore cannot alter an approved spec, a verdict, an evidence record, or an earlier round, whatever it writes.

Outputs are taken, never trusted in place.
After the run the factory:

1. checks that `out/` is still the directory it created (same device and inode, not a symlink), and refuses the run otherwise;
2. opens only the file names expected of the role, each without following a symlink, as a regular file under a size cap;
3. validates each against its schema and the joins of section 6;
4. archives into its store only the files that passed, and stages them into later runs from there.

Everything else in `out/` and all of `scratch/` is deleted.
The bundle is hashed before and after the run, and a changed hash fails the run.

Tests, per harness, with a throwaway role skill and no real task:

- allowed: create, overwrite, and delete a file in `out/` and in `scratch/`; for the builder, in the worktree;
- denied, by the shell and by the file tools separately: write, rename, and delete in `task/`, `skills/`, and `snapshot/`; write in a git directory; rename or replace `task/` or the attempt directory; for a non-builder, any write in the project worktree;
- detected after the run: `out/` replaced by a symlink, an expected output that is a symlink, an oversize output, and an unexpected extra file, none of which reaches the store.

## 2. Closed-by-default reads, snapshots, scratch copies

Owner decision Q57, option (a): agent sandboxes use the same trust model as step 2's project commands.
An agent's shell and file tools can read only the worktree or snapshot, the project's git directories (read-only), the attempt directory, the declared toolchain roots, and the fixed system list of `src/verify/sandbox.ts`, with the dispatch deny-list applied again on top.
Network is off for every agent run.

Agents run project commands directly in that sandbox; there is no command broker in the normal path.
This is safe for the reviewed code because of where the commands run:

- The snapshot is a detached checkout of the commit under review, write-denied, whose history is readable so `git diff` and `git show` work.
- `scratch/repo/` is a copy of the same commit that the factory prepares the way it prepares a worktree for its own checks: the project's setup command, in the setup phase, through the registry proxy only, before the agent starts and before the network is cut.
- A code-stage reviewer or auditor runs the project's commands and its own probe tests only in `scratch/repo/`.
  Project code executed there has the agent's permissions, which is why those permissions are closed by default: it can read the same code and the task folder, and write only `out/`, `scratch/`, and itself.
- The factory never reads code, test results, or exit codes back from `scratch/repo/`.
  The factory's own checks stay the authority on whether a command passes.

A run that executes project code can still write a forged file into `out/`.
Section 1 (expected names only, validated) and section 6 (joins against the factory's own records) are what make that harmless.

Step 4b must prove both harnesses under closed-by-default reads before any skill is trusted.
Codex's `:workspace` profile allows reads from the filesystem root today, so the Codex profile cannot keep extending it unchanged.
The proof, per harness: a canary file in a directory that is not on the deny-list and not under an allowed root is unreadable by the shell and by the file tools, while `bun test` in `scratch/repo/`, `git diff` in the snapshot, and a read from `skills/` all work.

Fallback, per harness, only if that harness cannot be closed by default: its agents lose the ability to execute project code themselves, and `project.commands` in the brief names a factory broker that runs each command under step 2's Seatbelt profile with `scratch/repo/` as the only writable root.
The skills do not change in that case, because they only ever say to run the commands the brief gives.

## 3. Agent types

No run may start a subagent the factory did not approve for it, and the control has to act before the subagent starts.
The mechanism, the unverified harness behavior it rests on, and the tests are in `docs/skills-delivery.md`; the rule the factory enforces is:

- Every role but the spec lead runs with no way to start a subagent: no `Agent` tool in Claude Code, and `agents.enabled=false` in Codex.
- The spec lead may start exactly the members of `spec-lead/team.json`, and a team member may start nothing.
  Whether the right members ran for the confirmed tier is a separate check, in section 4.
- If a harness cannot enforce that list before launch, the factory refuses to dispatch a spec lead with a team on that harness.
  A check of the event stream after the run is a second line, never the control.

## 4. Child run briefs for the spec team

A team member is not dispatched by the factory, so it has no prompt of the factory's.
The factory therefore generates, for each triggered member, the member's subagent definition for this one run, and puts a child run brief in it.
The definition is the member's system prompt, which the spec lead cannot read or change.

The child brief is a `<factory_run>` block with `taskId`, `attemptId`, `role` (the member's name), `parentRole: "spec-lead"`, `stage: "spec"`, `round`, `baseSha`, `worktree`, `taskDir`, `outDir`, `skillsDir`, `scratchDir`, `project`, and two members of its own:

- `reads`: the files the member reads, as absolute paths in `outDir` (this run's team brief and decision files) and `taskDir`;
- `writes`: the one absolute path in `outDir` the member may write.

The spec lead's message to a member is task data, like the team brief: it can say what the lead needs decided, and it cannot change the member's role, paths, or rules.

Which members a task triggers follows the design's table: all four for a new project or a confirmed tier L, and the threat modeler alone for the security flag at tier S or M.
The tier is confirmed inside the lead's run, and a promotion to L there needs the whole team at once, so the factory generates all four definitions for every spec lead run and the lead's result says which it started.
Step 7 then verifies, from the harness's own records and never from the lead's account:

- every member the confirmed tier and flags trigger ran, and none ran that was not triggered;
- the order of `spec-lead/team.json` `phases` held: each member started after every member of the earlier phases had finished;
- each decision file was written by its own member's session, and the lead's session wrote none of them;
- each decision file's `Task:` and `Author:` lines equal the child brief's `taskId` and `role`;
- every id under Curated entries used exists in the catalog its line names, which need not be a catalog of the author's own (the threat modeler has none).

## 5. The spec file set, the review loop, and gate 1

- The factory computes `specSet` (run contract) from the files it validated and staged, and puts it in every later brief.
- A spec-stage round is the spec reviewer and, when a threat model is required, the security auditor at stage `spec`, both on the same `specSet.sha256`.
  A threat model is required for a new project, a confirmed tier L, or the security flag in `spec-lead.json`.
- The round passes only when every verdict of the round approves, with `covers.specSetSha256` equal to the staged hash.
- When it does not pass, the spec lead is rerun with `previous.findings` listing every verdict of the round that has a blocking finding, by role and round, and with `previous.ownerFeedback` when the owner commented.
  Owner feedback is never merged into a reviewer's file.
- The lead's revision is complete: `spec.md` and `spec-lead.json` every round.
  A decision file carries over unchanged unless its specialist was rerun, since the lead may not write one.
- The factory archives each round under `archive/spec/round-<n>/`, each role's verdict in its own file, before it stages the next.
- From round 2 the reviewers get `previous.specSetDir`, and the factory checks that `resolutions` covers every blocking finding of that role's previous verdict exactly once.
- Gate 1 shows the owner the set and records the approval against `specSet.sha256`.
  Any change to any member after that, including a decision file or `spec-lead.json` alone, invalidates the approval and every verdict on the old hash, and the loop starts again.
- Every later output (build report, code-stage verdicts, verification plan and results) carries `specSetSha256`, and the factory rejects one that does not equal the approved hash.

## 6. Output joins

A schema can say a document is well formed; it cannot say the document is about this task, this revision, and things that exist.
The factory checks the following in code before it archives an output, and a failed join is a rejected output: one retry, then escalation.
Nothing is executed or published from an output that has not passed.

Every output:

- `taskId`, `attemptId` where present, `round`, `baseSha`, `headSha`, and `specSetSha256` equal the brief's.
- Every repo-relative path is confined: no leading `/`, no `.` or `..` segment, no backslash, and it resolves, without crossing a symlink, to a regular file tracked at the commit the output covers.

`verdicts/*.json`:

- `role` and `stage` equal the brief's.
- `findings[].n` is 1 to k with no gap and no repeat.
- Every `acIds` entry is a criterion of the approved spec, or an id in `retiredCriteria`, which is how a finding about a criterion that should not have been retired is stated.
- `location.file` exists at the reviewed commit, or, with `location.side: "base"`, existed at `baseSha` and is deleted by the diff, which is how a finding about a deletion is stated.
  Any other missing path or unknown criterion id is an invalid reference.
- `resolutions` covers every blocking finding of the role's previous verdict exactly once, and every `carriedAs` names a finding of this verdict.
- code-reviewer: `checks.acCoverage` has exactly one row per criterion of the approved spec, in order; `checks.commands` includes the project's test command; an `approve` is refused when the factory's own run of that command at `headSha` did not exit 0.
- security-auditor: `checks.threatModel.present` equals whether `threat-model.md` is in the spec file set, and every `unmitigated` id is a threat id in that file.
- database-auditor: `checks.migrations` has one row for every file the diff adds, changes, or deletes under `project.migrationGlobs`.

`build-report.json`:

- `mode` equals the brief's stage, and `inputSha` equals the commit the factory checked out for the run (section 8).
- `acceptanceCriteria` has exactly one row per criterion of the approved spec, in order, with the spec's tags.
- `filesChanged` equals the paths `git status` reports changed since `inputSha`.
- Every listed test exists in its file in the worktree.
- In `repair` and `resume`, `reproduction` equals the previous report's once that report recorded a red run.
- `findingsAddressed` has exactly one entry per finding in `previous.findings` and per owner comment.

`verification/plan.json`, before anything is executed:

- `criteria` has exactly one entry per criterion of the approved spec, in order, with the spec's tags.
- Test ids, capture ids, and capture names are each unique in the plan.
- Every test's `file` is confined as above and contains the test's `name`; the factory runs a test only by a confined path.
- `reproduction: true` appears only on a test of `AC-1` of a task whose kind is bug.
- Every `fixture` is in `project.fixtures`.

`verification/evidence/index.json`, which the factory writes, before the judge run:

- It validates against `verifier/evidence-index.schema.json`.
- Every planned test and capture has, for each of its sides and viewports, either a completed record or a `notExecuted` entry, and nothing else is present.
- Every test run and capture has the `commitSha` of its side; a `base-with-head-tests` run has the base's code and the head's test files.
- Every staged screenshot is a PNG whose bytes hash to its record's `screenshotSha256`.
- Every text field has been through the redactor (section 9).

`verification/results.json`, before anything is published:

- `planSha256` and `attemptId` equal the evidence index's, and the index's `baseSha` and `headSha` are still the pull request's.
- `rows` has exactly one row per criterion of the approved spec, in order, and each row's `tag` and `method` equal the plan's.
- `ownerChecklist` has exactly one item per `manual` row.
- Every proof entry's `planId`, `side`, and `viewport` name a record of the index: a test proof's `status` equals that record's, and a screenshot proof's `sha256` equals the record's and the stored file's bytes.
- A `pass` on a `test` row has a proof with status `pass` on side `head` for every planned test of the row, and for a reproduction test also a proof with status `fail` on side `base-with-head-tests`.
- A `pass` on a `browser` row has a head screenshot proof at both viewports for every planned capture of the row.
- A row whose plan method is `unsupported` is `blocked`, and no row passes on evidence the index lists under `notExecuted`.

Step 5 ships these with mutation tests: each rule above has a document that is valid in every other respect and must be rejected.
The mutations already kept beside the schemas (an approval with no commands, a pass resting on a base run, a declared test deletion) are the starting list.

## 7. Test integrity

The factory blocks any diff that deletes, skips, or weakens a test, and a declaration in the build report never lifts the block.
Compared between `baseSha` and `headSha`, by test file and test name:

- a test present at base and absent at head, or marked skip, todo, only, or expected-to-fail at head, is a block;
- a changed test configuration, coverage threshold, lint rule, or type-check strictness that loosens a check is a block;
- a test whose assertions changed is allowed only when the report lists it in `existingTestsChanged` with an approved criterion that changes the behavior it asserted, and the test still asserts that behavior's new expected result.

The last case is judged by the code reviewer; the first two need no judgment and are decided by the factory before review tokens are spent.

For a bug, the factory also reproduces the red run itself: the head's test files on the base's code, where the `AC-1` test must fail and the rest of the suite must not newly fail.
The builder's `reproduction` block is a claim; this run is the proof.

## 8. Builder checkouts, install, and resume

| Mode | Worktree at start | `inputSha` | Budget |
|---|---|---|---|
| `build` | `baseSha`, clean | `baseSha` | One per approved spec file set. |
| `repair` | `headSha` of the findings, clean, with the builder's earlier work committed by the factory | that `headSha` | One automated round; owner-requested repairs have their own budget. |
| `resume` | The commit the factory made after an install: the builder's partial work plus the manifest and lockfile changes | that commit | Does not spend a repair round. One per `build` or `repair` run; a second install request in the same run escalates. |

The builder never starts a repair from base, and a repair or resume never loses the reproduction: the factory carries the `reproduction` block forward and rejects a report that changes it.

Install, which only the factory can do because the builder has no network:

1. The approved spec names each new dependency by catalog entry id and package name.
   A version is in the spec only when the owner fixed one at gate 1.
2. The builder does not edit the dependency sections of a manifest or any lockfile.
   It writes code against the package, lists it in `dependenciesAdded` with `installed: false`, and reports an `install-needed` blocker.
3. The factory refuses a requested package that the approved spec does not name, or that is not in the `packages` of the catalog entry the spec cites.
4. For an entry whose `install` is `npm`, the factory runs the project's package manager in step 2's setup sandbox, through the registry proxy only, adding each package at an exact version: the spec's when it states one, otherwise the version recorded in the catalog entry's evidence when it was verified.
   The lockfile the package manager writes is the pin.
   A resolution failure, a peer conflict, or a package that needs a host outside the registry allowlist escalates to the owner; the factory does not try another version.
5. The factory commits the builder's partial work together with the manifest and lockfile, and reruns the builder in mode `resume`.

For an entry whose `install` is `cli` or `copy-paste`, the factory has nothing it can fetch: the source lives on the entry's own site or component registry, which the registry proxy does not reach.
Such an entry is usable in v1 only from a pinned local source, meaning files the owner has already committed to the project, which the spec cites by path under Reused files.
Without one, the spec lead raises a blocking open question asking the owner to add the source, and a builder that finds the cited source missing reports an `owner-prerequisite` blocker.
No agent reproduces a component's source from memory.

CI configuration is not a way around a check, and is not forbidden work either.
The builder may change it when an approved criterion or plan step names the change; the factory and the reviewer still block a change that removes, skips, or loosens a check, whoever asked for it.

## 9. The evidence boundary

Owner decision Q56: verification evidence is treated like source code.
Hosted models may see it, including screenshots, and the factory may publish it to the project's private pull request; publishing screenshots is plan step 5.
This replaces the step 2 rule that evidence never leaves the factory host.

What the decision does not relax:

- The judge gets only the evidence index the factory validated (section 6) and the screenshots it hashed.
  Raw logs, raw console output, and the preview's private home stay in the state root and are never staged.
- Every text field of the index (log tails, failure excerpts, page text, console messages, URLs) goes through the factory's redactor, the same one that guards publication, and is capped before staging.
  A run whose text cannot be redacted with confidence is staged without that field and the field's `truncated` flag set.
- Only the publisher process publishes, from `results.json` after its joins pass, and never from an agent's final message.

## 10. Rebase

The design says the builder rebases once.
The builder cannot: an agent may not change git state, and the git directories are write-denied.
So the factory rebases once when the base branch has drifted, escalates on a conflict, and then treats the result as a new revision: new `baseSha` and `headSha`, checks rerun, auditors re-selected from the new diff, code review and verification rerun.
The design's sentence "the builder rebases once, and a conflict escalates" should read "the factory rebases once".

## 11. Routing and gate 2

These are decided by code, and no agent output can change them:

- Which model and harness runs each role comes from the approved routing in config and the confirmed tier, including when the owner overrides the builder for a task.
  The header line of the spec is a display of that routing, never its source.
- Reviewers and the verifier must be from a different vendor than the builder of the same task; the factory checks the observed model of each run against the routing and refuses a verdict from the wrong one.
  The security auditor's model is fixed, so for some builders it is the same vendor; its skill does not claim otherwise.
- Gate 2 opens only when the checks, every triggered verdict, and the verification results all cover the pull request's current base and head and the approved `specSetSha256`.
- A `manual` criterion is complete only when the owner's own observation is recorded against that head; nothing an agent writes records one.
- A `computer-use` criterion cannot be verified in v1.
  The factory stops a spec that has one before gate 1 and asks the owner to choose: retag it `manual` and accept the checklist item, or drop it.

## 12. Decision files copied into a project

For a new project the factory copies the decision files into the project's `docs/decisions/` unchanged, because they are the specialists' own work and the pilot measures it.
Where the spec lead resolved a conflict between them, the files still disagree.
So the factory also writes `docs/decisions/resolutions.md` from `spec-lead.json` `conflicts`, one entry per conflict with its sources, its summary, and its resolution.
A later reader, human or agent, treats `resolutions.md` as governing over any decision file it names; the spec lead and the spec reviewer read it first when it exists.
