# Software Factory - Design

Status: agreed on 2026-11-18 after a design session and two independent reviews (GPT-6.2-Astra, Fable 5.2).
Owner: solo builder.
Scope: a personal factory that turns requests into reviewed, verified pull requests.
Build order lives in [v1-plan.md](v1-plan.md).

## Goals

- Infrastructure as code: every agent, model, skill, threshold, and project is defined in `factory.config.ts`, and changing the model for a role is a one-line change.
- Any model can serve any role, switchable per role and per task tier.
- Extensible intake: GitHub first, then Linear, then WhatsApp and Teams, all normalized into one Task.
- Spec-driven development with two human gates.
- Opinionated, curated choices for design inspiration, frontend libraries, infrastructure, and architecture patterns.
- Verification through the Orca embedded browser, and `orca computer` once a project needs native control.
- Proof that the output meets the spec, through deterministic checks and per-criterion evidence.
- Audit log of every agent run: who, which model, which tokens, estimated cost.
- Later: self-improvement and benchmarking driven by recorded data.

## Non-goals for v1

- Auto-merge or auto-deploy.
- Webhooks, tunnels, or any public endpoint.
- opencode or API-key providers.
- Benchmarking and automatic retrospective PRs.
- Greenfield template command (`factory new`), planned for v1.1.
- `orca computer` verification, until a project has a native app.
- Running on the VPS.

## Environment

- Runs locally on one MacBook that already runs Orca 1.4.262.
- Model access is subscription only: Claude Max 20x (Claude Code) and ChatGPT Pro Lite (Codex CLI).
- Models in use: Claude Opus 5.5, Sonnet 5.5, Fable 5.2, and Codex GPT-6.2-Astra, GPT-6.2-Sol, GPT-6.1-Terra.
- Factory code is TypeScript on Bun, using `bun:sqlite` and `bun test`, with a pinned Bun version.
- Target projects choose their own stack, mostly TypeScript, sometimes Python.

## Architecture

The factory is a deterministic TypeScript state machine.
No LLM coordinator is used, because coordination must be deterministic and free.
The factory owns intake identity, task state, gates, approval evidence, deterministic checks, and the audit history.
Orca owns worktrees and workspace visibility.
The factory runs agents directly with `claude -p` and `codex exec --json` inside Orca-created worktrees, because only the CLIs expose sandbox mode, read deny-lists, network policy, environment stripping, and result JSON.
Directly launched sessions are not listed as Orca agents (spike 01); `orca search` indexes them afterwards with a resume command.
The factory keeps direct launch and may open a read-only Orca terminal that tails the run log for watching.
Intervention is cancel plus resume (`claude --resume`, `codex resume`).
Factory runs use dedicated harness homes, `CODEX_HOME=~/.software-factory/codex-home` and `CLAUDE_CONFIG_DIR=~/.software-factory/claude-home`, each logged in once by the owner on the same subscriptions.
No owner instructions, hooks, skills, plugins, or config reach factory runs; only the factory's own skills are installed there.

### Repository layout

- `factory.config.ts` defines agents (name, role, skills, model, effort, timeout, token budget), tier-to-builder and tier-to-reviewer mappings, auditor trigger rules, and registered projects.
- `skills/<name>/SKILL.md` holds one skill per role in the open Agent Skills format readable by both Claude Code and Codex, plus that skill's curated data and eval cases.
- `prices.ts` is a dated price table used for cost estimates.
- Live state lives outside git in `~/.software-factory/`: the SQLite database, logs, per-run config snapshots, and GitHub App metadata.
- Secrets live in macOS Keychain.

### Task model

All intake adapters produce one shape:
`Task { source, externalId, project, kind: feature | bug, title, body, attachments, sender, thread, revision, replyTo }`.
Adapters have three jobs: parse inbound messages, reply with status, and map source context to a registered project.
Sender authorization and project routing happen before attachments are fetched or any agent is dispatched.
In v1 the only authorized sender is the owner, and the owner applying the `factory` label is what authorizes a specific issue revision.
Tasks are keyed by source, repository, and issue identity, and deduplicated on that key.
Ambiguous project routing results in a clarifying question in the source channel.
If an issue is edited after its spec is approved, the factory comments and waits for the owner to re-trigger with `/respec`.

### State machine

`received -> triage -> spec_drafting -> spec_review_loop -> awaiting_spec_approval -> building -> checks -> code_review (+ triggered auditors) -> repair -> verifying -> awaiting_pr_approval -> done`.
Owner feedback edges: changes requested at gate 1 return to `spec_drafting`; changes requested at gate 2 go to `repair`.
Owner-feedback repairs have their own budget, separate from the single automated repair round.
A failed verification spends the remaining automated repair allowance, then escalates.
Side states: `escalated`, `cancelled`, `failed`, `throttled`.
`throttled` reads the reset time from the provider's rate-limit event and restarts the stage after it.
Every stage has a timeout and a token budget from config; exceeding either escalates.
v1 runs one active task at a time, and a task parked at a human gate releases its slot.

### Crash safety

Before any side effect, the factory persists a unique attempt id together with the intended action.
On restart it looks for the existing worker, branch, or PR by that attempt id and adopts it before retrying.
If it cannot establish whether a worker started, it escalates instead of guessing.
Crash recovery is tested with a fake dispatcher that kills the process at every transition.

### Revision binding

Every verdict, check result, and verification result records the base and head SHAs it covers.
After any repair or rebase, the factory recomputes the diff, re-selects auditors, re-reviews the delta, and reruns checks and verification.
The factory checks the base branch for drift before verification, rebases once if needed, and escalates a conflict.

## The team

Names are decorative display names in config, used consistently in Orca workspace names, PR comments, commit trailers, and audit rows.

| Role | Default model | When it runs |
|---|---|---|
| Triage | Sonnet 5.5, low | Every task: provisional tier and risk flags |
| Spec lead | Opus 5.5, high | Every task |
| - Architect (subagent) | Opus 5.5, high | New project or tier L |
| - Infra (subagent) | Sonnet 5.5, high | New project or tier L, after Architect |
| - Frontend (subagent) | Sonnet 5.5, high | New project or tier L, after Architect |
| - Threat modeler (subagent) | Sonnet 5.5, high | New project, tier L, or security risk flag |
| Spec reviewer | GPT-6.2-Astra, high | Every task |
| Builder | By tier: S Sol 6.2, M Sonnet 5.5, L Opus 5.5 | Every task |
| Code reviewer | L: GPT-6.2-Astra high; S and M: opposite vendor of builder (Sol 6.2 for Claude builders, Opus 5.5 for Sol builders) | Every task |
| Security auditor | GPT-6.2-Astra, high | New project, tier L, or diff matching security path globs or spec-declared flags |
| Database auditor | Opus 5.5, high | Diff touching schema or migration paths |
| Verifier | Opposite vendor of builder: Sonnet 5.5 or GPT-6.1-Terra | Every task |
| Skill author | Fable 5.2, high, reviewed by GPT-6.2-Astra | Any skill creation or edit |

The specialist team runs inside the spec lead as harness-native subagents, each loading its own skill and model.
The factory dispatches only the spec lead.
The cross-vendor rules for code review and verification are enforced in code, not in prompts.
Each run records requested and observed model separately; a mismatch or unknown observed model is flagged in the audit.
Whether the subagent team beats a single spec lead is measured on the pilot (see v1-plan step 7).

## Spec stage

1. Triage assigns a provisional tier and risk flags at intake.
2. Spec lead drafts problem, non-goals, and acceptance criteria, grounded by citing the existing files and patterns it will reuse, by path.
3. For a new project or tier L, the spec lead runs its subagents: Architect first, then Infra and Frontend in parallel reading the Architect's decision, then the Threat modeler when triggered.
4. Each subagent writes one decision file in the task's spec folder (`architecture.md`, `infra.md`, `frontend.md`, `threat-model.md`) with decision, options considered, rationale, curated entries used, and assumptions.
5. The spec lead resolves conflicts and records why; a conflict that changes acceptance criteria goes to the owner.
6. The spec lead merges everything into one spec with an implementation plan and a confirmed tier; a tier promotion schedules the newly required work.
7. The spec reviewer writes a verdict JSON file at a fixed path: `approve`, or `changes` with numbered blocking issues; the factory validates it against a schema and retries once on invalid output.
8. On revision the reviewer checks the full revision diff for new contradictions, lost requirements, and untestable claims, not just its prior issues.
9. After 3 rounds without agreement, the factory escalates to the owner with the disagreement summarized.

Agents never commit; the factory commits their outputs.
For new projects, decision files are copied to the project's `docs/decisions/`, so later tier S and M work follows them.

### Spec format

One Markdown file per task with: header, problem, non-goals, acceptance criteria, design choices, reused files, implementation plan, risks, open questions.
Header example: `Tier: M - Builder: Sonnet 5.5 - Code reviewer: Sol 6.2`.
Each acceptance criterion has a stable id (AC-1), fixture, action, expected observable result, and a verification tag: `test`, `browser`, `computer-use`, or `manual`.
Bugs follow a reproduce-first path: a failing reproduction becomes AC-1.

### Tiers

- S: single area, no schema or API change.
- M: several modules, or a new dependency.
- L: schema, auth, cross-cutting, or architectural change.

## Human gates

Both gates live in one draft PR opened by the factory's GitHub App.
Gate 1: the spec is the first commit; the factory prints the exact approval command containing the spec SHA, and the owner comments `/approve <spec-sha>`, optionally with `builder=<model>` to override the builder.
The factory accepts gate 1 only from the owner's GitHub user id, consumes each comment id once, and requires re-approval when any approved spec file changes.
Gate 2: after verification the factory marks the PR ready, and the owner approves with a normal GitHub review, which the factory checks is bound to the verified head SHA.
Every factory comment carries a hidden marker, factory comment ids are recorded, and factory text never begins with `/approve`; a test plants that case.
The owner merges and deploys.
Clarifying questions may also be asked and answered in the source channel.

## Build, check, review, verify

- The builder works in an Orca worktree under the harness sandbox (a Codex permission profile extending `:workspace` with deny entries, selected by `default_permissions` and never `-s`, which silently overrides it; Claude Code `--restricted` with sandbox, a fixed tool allowlist, and inline settings).
- Agents get a read deny-list covering `~/.software-factory`, `~/.ssh`, `~/.config/gh`, Keychain, and other credential stores, and their environment is stripped of secrets.
- Agent sandboxes move to closed-by-default reads (owner decision Q57): agents read only the worktree, the run's private dirs, the skill bundle, and declared toolchain roots, the same trust model as project commands, and they run project tests directly in that sandbox.
  Reviewers and auditors get a read-only snapshot of the reviewed code plus a disposable copy to run tests in, so the reviewed snapshot cannot change.
  Step 4b proves both harnesses work this way; a harness that cannot falls back to running its tests through the factory's project-command sandbox.
- Network is allowed only for stages that install dependencies; build stages run without network.
- Only the publisher process pushes and opens PRs, using short-lived GitHub App installation tokens minted from a private key in Keychain.
- Project setup, test, lint, typecheck, and preview commands, and git hooks, run sandboxed and never in a process that holds publishing credentials.
- Project commands run under a factory-written Seatbelt profile applied with `/usr/bin/sandbox-exec`, closed by default.
  They read only the worktree, a private home, the project's own git dirs, declared toolchain roots, and fixed system dirs, with the dispatch deny-list applied again on top.
  They write only the worktree and the private home, never the git dirs, and reach no keychain and no unix socket.
- Network follows the phase.
  Setup connects only to a factory-run egress proxy that tunnels to the project's allowlisted registry hosts on 443, checks a per-phase credential, and dials only public addresses.
  The proxy's ports are bound once and held for the factory's lifetime; ending a phase revokes its credential, so every process the phase started, found or not, reaches only the factory and is refused.
  Setup may listen on nothing, and the preview may listen only on its own port, so no sandboxed process can relay; the factory also refuses a preview that listens anywhere but `127.0.0.1`.
  The preview may connect to its own port only, and every network rule is IPv4 only.
  A command beside the live preview gets that port or no network, never egress.
- Previews, their private homes, port leases, logs, and evidence live under the state root, in a per-attempt directory created exclusively, outside every agent-writable root; cleanup removes only what the attempt created.
- Isolation is proven with a harmless credential canary before it is trusted.
- Deterministic checks: the factory runs the project's test, lint, and typecheck before any reviewer tokens are spent.
- For bugs, the reproduction must fail on base and pass on head.
- Diffs that delete or weaken tests are blocked.
- Code reviewer and triggered auditors get read-only access to the worktree with the spec and acceptance criteria, may run tests, and cite `file:line` and AC id per finding.
- Verification starts the preview from the reviewed commit on a task-specific port with the project's declared fixtures and a clean browser profile.
- Verification records the PR's base and head before anything is captured, previews the base as before and the head as after, and binds every capture to its commit.
  A PR whose base or head moved by the time evidence is published gets nothing; the attempt is stale and runs again.
- The clean browser profile is a fresh isolated Orca profile per attempt, created, used, and deleted by the factory, and checked to hold no GitHub session before capture.
  Each capture is bound to the preview's origin and to the live preview server, checked after load and again after the screenshot.
  Orca cannot restrict a page's requests to the preview origin, so every evidence record states that browser egress was unrestricted.
- Every verification observation is a required check that keeps its own status: a probe's exit code, a teardown's report, screenshot hashes, the expected change.
  An attempt passes only when every check passes, and only a passed attempt is published.
- UI evidence uses fixed viewports and before/after screenshots against base, judged against the frontend skill's rubric.
  The mobile viewport uses Orca's device preset, so the page loads with the device's size, touch input, and user agent.

### Evidence table

The PR body is an acceptance evidence table: AC id, tag, fixture, action, expected, observed, proof (test name, screenshot, console log), commit, verdict.
Screenshots, logs, and full records stay on the factory host, in `~/.software-factory/evidence/<attempt>`, and are kept until the owner removes them.
The store is owner-only, and every file in it is created exclusively, never through a symlink, and within a per-file and per-attempt size limit.
A screenshot is cited in the PR by its SHA-256, its commit, and its viewport.
Owner decision Q56 (after step 2): evidence may be published to the PR on GitHub, since repos are private; screenshot publishing returns in plan step 5, with the same redaction rules for text.
The PR gets one text-only comment from the App per attempt, with allowlisted fields in the open and diagnostics redacted, capped, and fenced.
The comment starts with a hidden marker naming the PR, the attempt, the base, the head, and the captured revision, and a retry of the same attempt updates that comment instead of adding another.
`manual` criteria become an owner checklist and require the owner's recorded observation before completion.
No PR reaches gate 2 without evidence for every criterion.

## Curated catalogs

- Frontend skill: inspiration sites (navbars, footers, layouts), fonts, and approved libraries such as cmdk and beautifului.dev.
- Infra skill: approved choices per category (hosting, database, auth, email, queues, payments, analytics, CI, observability).
- Architecture skill: preferred patterns and anti-patterns.
Entries carry category, url, tags, whenToUse, avoidWhen.
Inspiration entries are reference only; approved-library entries are installable dependencies.
For existing projects, the project's own components and conventions win over the catalog.
Agents pick only from the catalog, record picks with rationale in the spec, and flag gaps instead of going outside it.

## Skill authoring

Every skill and every later skill edit goes through the same pipeline.
Fable 5.2 drafts the skill; for catalogs it verifies each URL is live and each library is maintained.
GPT-6.2-Astra reviews it in the structured verdict loop, max 3 rounds, then escalates.
The result lands as a PR on the factory repo for the owner to approve.
Each skill ships with 2 or 3 eval cases run on pilot tasks before it is trusted.

## Projects

Each registered project declares repo path, base branch, stack, setup, test, lint, typecheck, and preview commands, port range, fixtures, and security and migration path globs.
The factory respects each project's own `AGENTS.md` and conventions.
The factory passes the project's `AGENTS.md` (and `CLAUDE.md` if present) to every run explicitly, for Claude via `--append-system-prompt-file`, so both harnesses see identical project instructions regardless of what each loads on its own.

## Triggers and notifications

A launchd-managed Bun daemon polls GitHub every 2 minutes for issues labeled `factory` by the owner, and for the owner's gate comments and reviews.
The `factory` CLI supports `run <issue-url | "text">`, `status`, and `cost`.
Orca automations are not used for polling, because each run starts an agent.
The owner is notified through GitHub review requests and mentions on escalation, and through Orca workspace status.

## Audit and cost

Primary usage source is each CLI's result output captured at exit: Claude `modelUsage` and `total_cost_usd`, Codex `turn.completed` usage.
Fallback is the session files: Claude transcripts deduplicated by message id, Codex `token_usage_record` lines deduplicated by response id, excluding history copied into subagent files.
Rows are keyed by task, stage, attempt, agent session id, requested model, observed model, effort, prompt revision, base and head SHA, and outcome.
Codex cost is tokens times the dated price table; all costs are labeled API-equivalent estimates.
Unrecoverable usage is recorded as unknown, never zero.
Commits carry `Factory-Task: <id>` and `Factory-Agent: <name>` trailers.
Signals for later improvement are recorded from day one: owner review comments, retries, clarifying questions, escalations, tokens.
`factory cost --by task|project|model|stage` reports in v1.

## Later

- v1.1: `factory new <name> --stack ts|python` from a house template extracted from the owner's first real project.
- Linear adapter, then WhatsApp and Teams through a small webhook inbox on the owner's VPS that verifies signatures, queues messages, and is pulled by the laptop over an outbound connection.
- Benchmarks replaying frozen past tasks with hidden future history and held-out acceptance checks; model swaps land via PR.
- Retrospective improvement PRs once benchmark replay exists; until then, changes are driven by observed failures.

## Security

- Issue text, attachments, repo scripts, and preview pages are untrusted data, never instructions.
- Only owner-labeled issues start work.
- Merge and deploy authority stays with the owner.
- Model inference sends repository content to Anthropic and OpenAI under the owner's subscriptions.
- Each GitHub operation mints its own installation token, limited to the named repository and the permissions it needs, and refuses a token GitHub granted less than asked.
  A token is refreshed 5 minutes before it expires, and an expired one is never used; the App does not request `issues: write`.
- Hosted models may see verification evidence, including screenshots and redacted logs, the same as source code (Q56); raw logs with secrets never reach a model or GitHub.
- Until plan step 5, the PR gets redacted text only; from step 5, screenshots are published to the PR as well (Q56).
- Accepted residual: a surviving setup process can connect to the Mac's LAN address at its proxy port, which Seatbelt cannot tell from loopback (spike 02, blocker 3 follow-up).
  Only an unsandboxed local process listening on that port could answer and relay, and a local accomplice outside every sandbox already defeats the model.
  The proxy ports are released only when the factory process exits, and an attempt that leaves a survivor is quarantined.
- Known gap: the verification browser's network is not restricted (spike 02, Q52).
  A preview page can request any host while it is captured; the profile holds no credentials and no GitHub session, and the records list every other origin the page requested.
