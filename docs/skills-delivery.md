# Skills delivery proposal

Status: proposal from plan step 4a, to be wired and tested in step 4b.
Nothing here is implemented yet, and no code under `src/` was changed to write it.

## The problem

Step 1 made factory runs hermetic by switching skill discovery off in both harnesses.
Claude Code runs with `--restricted`, `--disable-slash-commands`, and a dedicated `CLAUDE_CONFIG_DIR`; Codex runs with `skills.include_instructions=false`, `skills.bundled.enabled=false`, and a dedicated `CODEX_HOME`.
Spike 01 recorded the consequence: turning skill listings off also hides anything the factory installs, so step 4 has to supply factory skills another way or revisit the flags.

Four things have to reach an agent, and none of the owner's may come with them:

1. The role skill: the body of `skills/<role>/SKILL.md`.
2. Its resources: files the skill points at under its own folder and `skills/_shared/` (catalogs, schemas, checklists, the run contract).
3. For the spec lead only, its team: four harness-native subagents (architect, infra, frontend, threat-modeler), each with its own skill, model, and effort, defined in `skills/spec-lead/team.json`.
4. The same for each subagent: its skill body and its resources.

## Constraints

- **No owner content.**
  The owner's skills live in `~/.claude/skills` and `~/.agents/skills`; both are read-denied to agent tools, and discovery must not list them.
- **The worktree is untrusted.**
  A project, or an earlier agent run, can place `.claude/skills`, `.claude/agents`, `.agents/skills`, or `.codex/agents` in the worktree.
  Nothing found there may load.
- **The state root is unreadable.**
  `~/.software-factory`, including both dedicated harness homes, is on the mandatory read deny-list, and `assertPolicySound` refuses any readable carve-out that overlaps it.
  A file an agent must open with its own tools cannot live there.
- **Instructions are pinned to a commit.**
  Project instructions are built from git blobs at an approved commit, never from a working tree (`buildProjectInstructions`).
  Skills deserve the same, since a skill is a stronger instruction than an `AGENTS.md`.
- **Codex takes instructions in argv.**
  `MAX_INSTRUCTIONS_BYTES` is 256 KiB because macOS caps argv plus environment at 1 MiB.
- **Selection is the factory's.**
  The state machine knows the role of every run.
  Which skill applies is never a model decision.

## What the harnesses do

Established in spike 01 or in the harness documentation as read on 2026-11-19 (Claude Code 2.1.325 and codex-cli 0.169.0 are installed).
Items marked unverified are behavior this proposal relies on and step 4b must prove before trusting.

| # | Fact | Source |
|---|---|---|
| 1 | Claude: with `--disable-slash-commands`, `system/init` reports `skills: []` and `slash_commands: []`. | Spike 01 |
| 2 | Claude: text passed with `--append-system-prompt-file` reaches the main agent; the worktree's `CLAUDE.md` does not under `--restricted`. | Spike 01, codeword test |
| 3 | Claude: `--add-dir` grants file access to a directory, and also loads `.claude/skills`, `.claude/commands`, and `.claude/agents` found inside it. | Claude Code skills docs |
| 4 | Claude: `--agents` takes subagent definitions as JSON, or with `-p` a path to a JSON file (v2.1.281 or later), with `prompt`, `description`, `tools`, `model`, and `effort` per agent. | Claude Code CLI and subagent docs |
| 5 | Claude: a subagent receives only its own system prompt and basic environment details, not the main session's system prompt. `--append-subagent-system-prompt-file` appends text to every subagent's prompt. | Claude Code subagent docs |
| 6 | Claude: the main session needs the `Agent` tool to start a subagent; the factory's tool list (`Bash,Read,Edit,Write,Glob,Grep`) does not include it. Specific subagents can be denied with `Agent(<name>)` permission rules. | Claude Code subagent docs, `src/dispatch/claude.ts` |
| 7 | Claude: project subagents are discovered from `.claude/agents/` between the working directory and the repository root. Whether `--restricted` stops that is unverified. | Claude Code subagent docs |
| 8 | Codex: skill discovery reads `.agents/skills` from the working directory up to the repository root, `$HOME/.agents/skills`, `/etc/codex/skills`, and the bundled skills. `$HOME` is the account home, not `CODEX_HOME`. | Codex skills docs, spike 01 |
| 9 | Codex: there is no flag for an extra skills directory, and skills can only be disabled one by one (`[[skills.config]]`), not allowlisted. | Codex config reference |
| 10 | Codex: `developer_instructions` reaches the main agent; `project_doc_max_bytes=0` keeps the worktree's `AGENTS.md` out. | Spike 01, codeword test |
| 11 | Codex: with listings off, the multi-agent tools are still offered, and subagents run under the parent's sandbox profile. | Spike 01 |
| 12 | Codex: a custom agent is a TOML layer with `name`, `description`, `developer_instructions`, and optionally `model` and `model_reasoning_effort`, found in `~/.codex/agents/` or the project's `.codex/agents/`, or declared with `agents.<name>.description` and `agents.<name>.config_file`. | Codex subagents docs, config reference |
| 13 | Codex: declaring an agent with `-c agents.<name>.config_file=<path>` under `--ignore-user-config` works, and a project's `.codex/agents/` is not loaded. | Unverified |
| 14 | Codex: a subagent inherits the parent's skills setting, so it lists none either. | Codex subagents docs; unverified under these flags |

## Options

### A. Install factory skills into the dedicated homes and turn discovery back on

Copy `skills/*` into `claude-home/skills` and `codex-home/skills`, remove the flags that hide listings, and let each harness discover and load the skill.

- For: the native path, with progressive disclosure built in; nothing new to build.
- Against, Codex: turning listings on lists the owner's `$HOME/.agents/skills` and the worktree's `.agents/skills` again (fact 8), and there is no allowlist (fact 9).
  Disabling each unwanted skill by path means enumerating directories the factory does not control, and a skill added tomorrow is on by default.
  That is re-enabling the owner's skills, which this step must not do.
- Against, Claude: dropping `--disable-slash-commands` brings back the built-in skills and commands.
- Against, both: the homes are read-denied to agent tools, so a skill's resources there cannot be opened; the policy would need a readable carve-out inside the state root, which `assertPolicySound` refuses for good reason (the homes hold credentials).
- Against, both: loading becomes a model decision made from a description.
  A run can skip its skill or load another role's, and the factory finds out only from the output.
- Against, both: the homes are shared by every run, so an install is global mutable state and not pinned to the commit a task started on.

### B. Pass everything through the instruction channel

Inline the skill body and every resource into the text step 1 already delivers (`--append-system-prompt-file`, `developer_instructions`).

- For: one mechanism, already proven by codeword test in both harnesses; deterministic; discovery stays off.
- Against: resources do not fit the channel.
  The frontend catalog alone is 45 KB and the bundle without eval fixtures is 332 KB, while Codex's argv budget of 256 KiB also has to hold the project instructions.
  Every run would pay for catalogs and schemas it never consults.
- Against: it gives up the property that makes skills cheap, which is that reference material is read when needed.
- Against: subagents get none of it; fact 5 says a Claude subagent does not see the main system prompt.

### C. A per-run skills directory with native discovery

Write the selected skills into a fresh directory per run and point discovery at it: `--add-dir <dir>` with a `.claude/skills` inside for Claude, and for Codex a `.agents/skills` in the working directory.

- For: native loading and progressive disclosure, scoped to one run, pinned to whatever the factory wrote.
- Against, Codex: there is no way to add a skills directory outside the repository (fact 9).
  The only repo-scoped location is `.agents/skills` in the worktree, which the agent can write and the project can already populate, and listings must be on to see it, which lists the owner's skills too.
- Against, Claude: the Skill tool and listings must come back, and with them the built-ins unless each is denied.
- Against, both: loading is still a model decision.
- Against: the two harnesses would be delivered to differently, so one test could not cover both.

### D. Skill body through the instruction channel, resources in a per-run read-only bundle, team as generated native subagents

The factory, which already knows the role, puts the role's `SKILL.md` body into the instruction channel of step 1.
Resources are copied from git into a per-run directory the agent can read with its ordinary file tools and cannot write.
The spec lead's team is generated per run as native subagent definitions whose prompts carry each member's skill body.
Discovery stays exactly as off as it is today.

- For: the skill always loads, by construction, and it is the right one; there is nothing to trigger.
- For: discovery stays off in both harnesses, so the owner's skills, the built-ins, and anything planted in the worktree stay unavailable without enumerating them.
- For: progressive disclosure is kept; a catalog or schema is read when the skill says to.
- For: the same shape in both harnesses, so one test design covers both.
- For: pinned to a factory commit, like project instructions, and outside every agent-writable root.
- Against: the factory reimplements a small part of what a skill loader does: strip the frontmatter, compose the prompt.
  The `description` field no longer selects anything at run time; it documents when the factory applies the skill and keeps the folder a valid Agent Skill for use outside the factory.
- Against: one more directory per run to create, protect, and remove.
- Against: per-run subagent files are a new input that needs the same care as the instruction file.

| | A: homes plus discovery | B: all inline | C: per-run discovery | D: inline body plus bundle |
|---|---|---|---|---|
| Owner and worktree skills stay unavailable | No (Codex), built-ins return (Claude) | Yes | No (Codex) | Yes |
| The right skill always loads | No, model decides | Yes | No, model decides | Yes |
| Resources readable on demand | No, homes are read-denied | No, all in context | Yes | Yes |
| Fits Codex's argv budget | Yes | No | Yes | Yes (largest skill body is 14 KB) |
| Pinned to a commit | No | Yes | Yes | Yes |
| Same mechanism in both harnesses | No | Yes | No | Yes |
| Reaches native subagents | Unclear | No | Unclear | Yes |

## Recommendation: option D

### The bundle

A new function beside `buildProjectInstructions`, with the same discipline, materializes the bundle for a run:

- **Source**: tracked blobs under `skills/` at a full commit id of the factory's own repository, read with `git ls-tree` and `git cat-file` from a checkout outside every agent-writable root.
  Never a working tree.
- **Selection**: every skill folder plus `_shared/`, minus every `evals/` folder.
  Eval fixtures hold answer keys and planted defects and must never reach an agent.
  Shipping every role's folder is deliberate: reviewers read other roles' references (the spec format, the UI rubric, the catalogs), and a role-specific subset would have to be kept in step with those cross-references by hand.
- **Refusals**: a symlink, a non-regular file, a path segment that starts with a dot (so no `.claude`, `.agents`, or `.codex` directory can ever exist in a bundle), a file over a size cap, or a bundle over a total cap.
- **Destination**: `<run root>/<attempt id>/skills/`, where the run root is a private factory directory that is outside the state root, outside the worktree, outside every temp directory, and checked the way `assertSafeDir` checks the others.
  This is `skillsDir` in the run brief.
- **Protection**: files are written read-only, and the directory is added to the sandbox policy's `denyWrite` in both harnesses.
  After the run the factory re-hashes the bundle; a changed hash fails the run.
- **Audit**: the factory commit id and the bundle's hash are recorded with the attempt, so every verdict can be traced to the exact skill text that produced it.

The task folder (`taskDir`) and the scratch directory (`scratchDir`) of `skills/_shared/run-contract.md` are siblings of the bundle under the same attempt directory, writable where the bundle is not.

### The instruction text

The factory composes one text per run, in this order, and delivers it through the channel step 1 built:

```text
<factory_skill name="builder">
(body of skills/builder/SKILL.md, frontmatter removed)
</factory_skill>

<factory_run_contract>
(skills/_shared/run-contract.md)
</factory_run_contract>

<project_instructions>
(as today)
</project_instructions>
```

The skill comes first because it outranks the project's instructions, and the run contract is inlined because every run needs it before its first action.
The run brief (`<factory_run>` with `taskDir`, `skillsDir`, `scratchDir`, and the rest) goes in the prompt, as the run contract describes.
The combined text stays under `MAX_INSTRUCTIONS_BYTES`; the largest skill body is 14 KB and the run contract is 6 KB.

### Claude Code

Main agent, all roles:

```text
claude -p ... --restricted --disable-slash-commands --strict-mcp-config   (unchanged)
  --append-system-prompt-file <instruction text file>                      (now skill, contract, project instructions)
  --add-dir <attempt>/skills --add-dir <attempt>/task --add-dir <attempt>/scratch
  --settings '{... denyWrite and Edit/Write deny rules for <attempt>/skills ...}'
```

`--add-dir` is needed because the settings set `blockReadsOutsideWorkingDirectories`.
It would also load `.claude/skills` from the added directories (fact 3); the bundle cannot contain one, and the task and scratch directories are covered by the test below.

Spec lead only:

```text
  --tools Bash,Read,Edit,Write,Glob,Grep,Agent
  --agents <attempt>/agents.json
  --settings '{... "deny": [..., "Agent(Explore)", "Agent(Plan)", "Agent(general-purpose)", "Agent(fork)"] ...}'
```

`agents.json` is generated per run from `skills/spec-lead/team.json`, one entry per member:

```json
{
  "architect": {
    "description": "(team.json description)",
    "prompt": "<factory_skill name=\"architect\">...</factory_skill>\n<factory_run_contract>...</factory_run_contract>\n<project_instructions>...</project_instructions>",
    "tools": ["Read", "Glob", "Grep", "Write"],
    "model": "(factory.config.ts, role architect)",
    "effort": "(factory.config.ts, role architect)"
  }
}
```

Each member's prompt carries the whole instruction text, because a Claude subagent sees nothing of the main session's system prompt (fact 5).
The members get no Bash and no Agent tool: a specialist reads, decides, and writes one file.
The factory also checks the run's event stream afterwards: an Agent call naming anything outside `team.json` fails the run, which covers built-in subagent types the deny rules did not anticipate.

### Codex

Main agent, all roles:

```text
codex exec --json --ignore-user-config --ignore-rules ...                 (unchanged, discovery flags included)
  -c developer_instructions="<instruction text>"                          (now skill, contract, project instructions)
  -c 'permissions={factory={extends=":workspace", filesystem={..., "<attempt>/skills"="read", ...}}}'
```

Codex's profile already allows reads outside the workspace except the deny-list, so the bundle is readable where it sits; the explicit `read` entry keeps it unwritable even if a later profile change widens writes.

Spec lead only, one pair per team member:

```text
  -c 'agents.architect.description="(team.json description)"'
  -c 'agents.architect.config_file="<attempt>/agents/architect.toml"'
```

```toml
# <attempt>/agents/architect.toml, generated per run
name = "architect"
description = "(team.json description)"
model = "(factory.config.ts, role architect)"
model_reasoning_effort = "(factory.config.ts, role architect)"
developer_instructions = """
(the same instruction text as the Claude prompt above)
"""
```

Codex subagents inherit the parent's sandbox (fact 11), so a specialist there has the lead's write access rather than Claude's narrower tool list.
The spec lead checks what each specialist wrote in either harness (`skills/spec-lead/references/team.md`), and the factory's eval for the lead checks that each decision file was written by its own subagent's session.
If fact 13 fails, the fallback is to write the same TOML files into `codex-home/agents/` for the length of the run and remove them after; v1 runs one task at a time, so this is safe, but it is shared mutable state and is the second choice for that reason.

### What stays as it is

- Every discovery-off flag of step 1, in both harnesses.
- The dedicated homes, which keep holding credentials and session history and never hold skills.
- The read deny-list, including `~/.claude`, `~/.codex`, and `~/.agents`.
- Project instructions from git blobs at the approved base commit.

## The test that proves it

An end-to-end codeword test in the style of spike 01, run for both harnesses, plus unit tests on the argument builders.
It uses a throwaway factory skill so it does not depend on any real skill's wording.

### Setup

| Codeword | Where it is planted | Must be |
|---|---|---|
| KINGFISHER | Body of the factory skill `probe-lead`, delivered through the instruction channel | Reported |
| WAGTAIL | `probe-lead/references/token.md`, present only in the bundle | Reported, after the agent reads the file |
| NUTHATCH | Body of the factory skill `probe-member`, delivered only as a subagent definition | Reported by the subagent |
| DUNLIN | `probe-member/references/token.md`, present only in the bundle | Reported by the subagent |
| MAGPIE | Canary skill in the owner's `~/.claude/skills/factory-canary/SKILL.md` | Absent |
| JACKDAW | Canary skill in the owner's `~/.agents/skills/factory-canary/SKILL.md` | Absent |
| STARLING | `.claude/skills/canary/SKILL.md` and `.agents/skills/canary/SKILL.md` committed in the test worktree | Absent |
| BUNTING | `.claude/agents/canary.md` and `.codex/agents/canary.toml` committed in the test worktree | Absent |
| LINNET | `.claude/skills/canary/SKILL.md` planted in the task and scratch directories | Absent |
| REDSTART | `probe-lead/evals/fixtures/token.md` in the factory repository at the pinned commit | Absent from the bundle |

Each canary skill's description claims to apply to every task, so a harness that lists it has every reason to use it.
The owner canaries are created by the test and removed in a `finally` block; the test refuses to start if a file already exists at either path.

The prompt asks the agent to: state its skill's codeword; read `references/token.md` under its skill folder in `skillsDir` and state the codeword; start the `probe-member` subagent and relay the two codewords it reports; list every skill, slash command, and agent type available to it by name; and try to append a line to a file in the bundle.

### Assertions

For both harnesses:

1. The final answer contains KINGFISHER, WAGTAIL, NUTHATCH, and DUNLIN.
2. MAGPIE, JACKDAW, STARLING, BUNTING, LINNET, and REDSTART appear nowhere: not in the answer, and not in the full event stream or session rollout, which include system prompts, tool listings, and tool results.
3. The string `factory-canary` appears nowhere in the stream or rollout, so the canaries were not even listed.
4. The write to the bundle was refused, and the bundle's hash after the run equals its hash before.
5. `REDSTART` is not in any file of the materialized bundle, and no path in the bundle has a segment starting with a dot.
6. The subagent ran as its own session with the model and effort of its definition, which differ from the lead's in the test configuration.

Claude only:

7. `system/init` reports `skills: []` and `slash_commands: []`, as in spike 01.
8. Every Agent tool call in the stream names `probe-member`.

Codex only:

9. The rollout's turn context for the subagent thread shows the `factory` permission profile and no network access.
10. Asked for every skill it knows, Codex answers none, as in spike 01.

### Negative control

A test that only shows the canaries absent could pass because the canaries were planted wrongly.
So the same run is repeated once per harness with the discovery-off flags removed, against the same canaries, and must show `factory-canary` listed (Claude: in `system/init` `skills`; Codex: in the rollout's skill listing).
The control is what makes assertions 2 and 3 mean something, and it is the only run in which an owner skill is ever visible.

### Unit tests

In the existing `bun test` setup, with no model calls:

- The bundle materializer refuses a symlink, a dot-directory, an oversize file, and a source under an agent-writable root; excludes every `evals/` folder; reads the pinned commit and not a later commit or a working-tree edit.
- The instruction composer orders skill, contract, and project instructions, strips the frontmatter, and refuses text over the byte limit.
- `claudeArgs` adds `Agent`, `--agents`, and the built-in agent deny rules for the spec lead only, and never for another role.
- `codexArgs` emits one `agents.<name>` pair per team member for the spec lead only, and the bundle path as `read`.
- The generated agent definitions match `team.json` and `factory.config.ts`: every member present, the tool list as declared, model and effort from config.
- The event-stream check fails a run whose Agent call names a type outside the team.

## What step 4b has to wire

1. The run root, with its safety checks, and per-attempt `skills/`, `task/`, and `scratch/` directories.
2. The bundle materializer and its hash check before and after the run.
3. The instruction composer, replacing the project-instructions-only text in both `claudeArgs` and `codexArgs`.
4. Role-conditional arguments for the spec lead: `Agent` tool, `--agents` file, deny rules, and Codex `agents.<name>` overrides with generated TOML layers.
5. The run brief of `skills/_shared/run-contract.md`, including `skillsDir`, `taskDir`, and `scratchDir`.
6. The codeword test and the negative control above, then the eval cases under `skills/*/evals/`.

## Open risks

- **Facts 7 and 13 are unverified.**
  If the worktree's `.claude/agents` or `.codex/agents` load, the test's BUNTING assertion fails and the run needs another flag or a pre-run refusal of those paths in the worktree.
  If `agents.<name>.config_file` does not work from `-c`, use the stated fallback.
- **Built-in Claude subagent types.**
  Enabling `Agent` exposes them.
  The deny rules name today's built-ins, and the stream check catches the rest after the fact rather than before.
- **Codex specialists are not tool-restricted.**
  They inherit the lead's sandbox.
  The lead's checks and the eval for ghostwriting are the control; a specialist cannot reach the network or the deny-list either way.
- **Skill text is now a system-prompt input.**
  A change to any `SKILL.md` changes behavior on the next run with no install step, so the pinned commit and the recorded bundle hash are what make a run reproducible, and skill edits need the eval runs that the design already requires.
