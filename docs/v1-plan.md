# Software Factory - v1 Plan

Design: [design.md](design.md).
The [testing policy](testing-policy.md) governs coverage, proofs, evals, and reviews for every step from 4b onward.
Each step ships as its own PR on the factory repo, built by one Opus 5.5 Orca worker in sequence, and reviewed cross-vendor by Codex before the owner merges.
Every step with non-trivial logic ships with `bun test` coverage.

## 0. GitHub App

A private GitHub App owned by the owner's personal account, created through the manifest flow.
Permissions: contents write, pull requests write, issues write, metadata read; no webhook.
Installed only on `factory-pilot` at first, then on each registered project.
Private key, client secret, and webhook secret are stored in macOS Keychain under `software-factory.github-app.*`.
Created on 2026-11-18 as `software-factory-9f09` (app id 5820335, installation 183396381).
Non-secret metadata (app id, slug, installation id) lives in `~/.software-factory/github-app.json`.
Done when a script mints an installation token from the Keychain key and lists `factory-pilot`.

## 1. Spike: dispatch and Orca visibility

Create a worktree with Orca, run `claude -p` and `codex exec --json` inside it with sandbox, deny-list, no network, and stripped env.
Confirm: result JSON capture, exit codes, cancellation, and whether the session is visible and attachable in Orca.
If not visible, prove the fallback of running the CLI inside an Orca-created terminal in that worktree.
Prove the credential canary is unreadable from both harnesses.
Output: a short findings note and the chosen dispatch path.

## 2. Spike: verification

Start a sandboxed preview from a given commit on a task-specific port, drive the Orca embedded browser with a clean profile, capture fixed-viewport screenshots and console errors, and attach the evidence to a PR via the App.
Output: findings note and a reusable verification module.

## 3. Walking skeleton on `factory-pilot`

`factory-pilot` is a small Bun web app with planted issues.
Push one planted bug end to end with one builder, minimal hand-written prompts, both real gates, and a reproduction that fails on base and passes on head.
On the same path, exercise: a crash after dispatch and after PR creation, a stale `/approve`, a planted factory comment that begins like an approval, and a failed verification.
Includes the minimal state machine, SQLite store, attempt ids, GitHub adapter, publisher, and `factory run`.

## 4. Skills

Author every skill through the pipeline: Fable 5.2 drafts, GPT-6.2-Astra reviews, owner approves via PR.
Skills: triage, spec lead with its subagent team (architect, infra, frontend, threat modeler), spec reviewer, builder, code reviewer, security auditor, database auditor, verifier.
Catalogs: frontend (inspiration, fonts, approved libraries including cmdk and beautifului.dev), infra, architecture, with every URL verified live.
Each skill ships with 2 or 3 eval cases.
Replace the skeleton's hand-written prompts.

## 5. Deterministic checks and evidence

Factory-run test, lint, and typecheck before review; base/head reproduction for bugs; block weakened or deleted tests.
PR evidence table, manual-criterion owner checklist, before/after UI screenshots.

## 6. Spec and review loops

Spec review loop with validated verdict files, full revision-diff review, 3-round cap, escalation.
Code review with read-only worktree access and `file:line` plus AC citations.
Owner feedback edges at both gates, with their own budget.
Revision binding: re-review, re-check, and re-verify after repair or rebase.

## 7. Routing, auditors, and the spec team

Triage provisional tier, tier confirmation and promotion, tier-to-builder and tier-to-reviewer mappings, cross-vendor enforcement for review and verification, observed-model validation.
Security and database auditors with path-glob and spec-flag triggers.
Spec lead subagent team for new projects and tier L.
Run several pilot tasks with and without the subagent team and compare spec quality; drop the team if it does not win.

## 8. Usage and cost

CLI result capture as primary, session-file readers as fallback, dedupe rules, dated price table, unknown-not-zero, commit trailers.
`factory cost --by task|project|model|stage` and `factory status`.

## 9. Daemon

launchd-managed Bun daemon polling GitHub every 2 minutes for owner-labeled issues and gate actions.
Stage timeouts and token budgets, `throttled` handling from provider rate-limit events.
Crash-recovery test suite with a fake dispatcher that kills the process at every transition.

## 10. Judge calibration

Plant a subtle bug, a silently skipped acceptance criterion, and a weakened test in `factory-pilot`, each with an answer key the builder never sees.
Measure the catch rate of reviewers, auditors, and checks, and owner rework.
v1 is done when every planted defect is caught or the miss has a recorded cause and fix.

## After v1

The owner scaffolds the first real project (one Bun app, lint, test, `AGENTS.md`), registers it in `factory.config.ts`, installs the GitHub App on it, and drives all work through `factory`-labeled issues.
The v1.1 house template is extracted from that project.
