# Spike 01 - Dispatch and Orca visibility

Plan step: [v1-plan.md](../v1-plan.md) step 1.
Date: 2026-11-18.
Versions: Orca 1.4.262, Claude Code 2.1.325, codex-cli 0.169.0, Bun 1.2.10, macOS (Darwin 25.6.0).
Models: Claude `haiku` (resolved to `claude-haiku-5-5`), Codex `gpt-6-luna`, effort `low`; total spend was a few cents.
Home paths are shown as `~` and spike worktree names are shortened.

## Verdict

- Dispatch path: the factory spawns `claude -p` and `codex exec --json` directly (`Bun.spawn`) inside the Orca-created worktree, implemented in `src/dispatch`.
- A directly launched session is not visible live in Orca: it is absent from `orca agent list` and from the worktree's agents in `orca worktree ps`, so it cannot be attached.
- After the fact, `orca search` indexes both harnesses' direct sessions and returns a working resume command, so the owner can inspect and continue a session.
- The Orca-terminal fallback works (proven below), but it does not make the run an Orca agent either: `orca agent list` still does not list it, and it only adds a raw-output tab.
- Because the fallback buys no attachability and costs robustness and security, the recommendation is direct spawn plus an optional read-only Orca monitor tab that tails the run log, and intervention by cancel plus resume.
- This contradicts the design's fallback rule; see [Proposed design changes](#proposed-design-changes).

## 1. Worktree through the orca CLI

`src/orca/worktree.ts` shells out to `orca worktree create --name <n> --no-parent --setup skip --json` and `orca worktree rm --worktree id:<id> --force --delete-branch --json`.
Run from Bun by `bun scripts/spike-dispatch.ts <logDir>`:

```
### 1 worktree create
{
  "id": "8eb5b069-ff96-444d-b4ca-dbf34d486057::~/orca/workspaces/software-factory/spike-dispatch-1795022545099",
  "path": "~/orca/workspaces/software-factory/spike-dispatch-1795022545099",
  "branch": "refs/heads/Scylla23/spike-dispatch-1795022545099"
}
...
### 1 worktree rm
{ "removed": "8eb5b069-ff96-444d-b4ca-dbf34d486057::~/orca/workspaces/software-factory/spike-dispatch-1795022545099" }
```

Orca now prefixes new branches with the GitHub owner (`Scylla23/`) since the remote was added; the factory must read the branch from the result rather than derive it.
After all runs, `git worktree list`, `git branch -a`, and `orca worktree list` show no spike worktrees or branches.

## 2. Headless Claude Code

Command built by `claudeCommand` in `src/dispatch/claude.ts`:

```
claude -p --output-format stream-json --verbose --model <model> --effort <effort> --session-id <runId>
  --restricted --tools Bash,Read,Edit,Write,Glob,Grep --strict-mcp-config
  --permission-mode dontAsk --permission-prompts none --settings '<json>' -- <prompt>
```

The `--settings` JSON (from `claudeSettings`), shown with a shortened deny-list:

```json
{
  "permissions": {
    "allow": ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
    "deny": ["WebFetch", "WebSearch", "Read(~/.ssh)", "Read(~/.ssh/**)", "..."],
    "blockReadsOutsideWorkingDirectories": true
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true,
    "allowUnsandboxedCommands": false,
    "network": { "allowedDomains": [] },
    "filesystem": { "denyRead": ["~/.software-factory", "~/.ssh", "..."] }
  }
}
```

Why each flag:

- `--restricted` ignores user, project, and local settings files, so the owner's hooks (for example the RTK `PreToolUse` hook) and permission rules do not leak in, and `--settings` is the whole policy; it also confines file tools to the working directories.
- `--tools` is the fixed allowlist; `WebFetch` and `WebSearch` are also denied by rule.
- `--permission-mode dontAsk` with `--permission-prompts none` denies anything not pre-approved instead of waiting on a prompt nobody can answer.
- `sandbox.failIfUnavailable` makes Claude refuse to start rather than run Bash unsandboxed.
- `sandbox.allowUnsandboxedCommands: false` removes the model's `dangerouslyDisableSandbox` escape hatch.
- `stream-json` (with the required `--verbose`) gives the resolved model in the `system/init` event, a live log, and a parsable prefix when a run is killed; the final `result` event carries the same fields as `--output-format json`.
- `--` ends options, so a prompt starting with `-` is not parsed as a flag; the spike prompt starts with `- `.

Evidence (spike step 2, parsed by `runAgent`):

```
"exitCode": 0, "outcome": "completed",
"requestedModel": "haiku", "observedModel": "claude-haiku-5-5",
"sessionId": "04fdfd03-327c-4f04-8a7c-b1d5df6a3357"   (equals the --session-id we passed)
"usage": { "totalCostUsd": 0.00144798, "byModel": { "claude-haiku-5-5": {
  "inputTokens": 4, "outputTokens": 372, "cacheReadInputTokens": 19298, "cacheCreationInputTokens": 5343, "costUsd": 0.00144798 } } }
```

The raw `result` event also has `subtype`, `is_error`, `num_turns`, `permission_denials`, `terminal_reason`, and `modelUsage.<model>.costBasis: "list"`, so `total_cost_usd` is an API-list-price estimate, not subscription spend.
Auth works with the stripped environment (only `HOME`, `USER`, `LOGNAME`, `PATH`, `SHELL`, `TMPDIR`, `LANG`, `TERM`), because Claude reads its OAuth token from the macOS Keychain.

## 3. Headless Codex

Command built by `codexCommand` in `src/dispatch/codex.ts`:

```
codex exec --json --ignore-user-config --ignore-rules -m <model> -c model_reasoning_effort="<effort>"
  -c 'permissions={factory={extends=":workspace", filesystem={"~/.software-factory"="none","~/.ssh"="none",...}}}'
  -c 'default_permissions="factory"'
  -c 'shell_environment_policy.inherit="core"'
  -c allow_login_shell=false
  -C <worktree> -- <prompt>
```

stdin is `/dev/null` (`stdin: "ignore"`); Codex prints `Reading additional input from stdin...` to stderr and proceeds.
`--ignore-user-config` keeps auth working (auth still comes from `~/.codex/auth.json`).

Do not pass `-s workspace-write`.
It silently wins over `default_permissions`, so the deny-list is dropped without any error.
Captured with `-s workspace-write` plus the same profile (manual run, before the state-dir rename):

```
READ-OK ~/.factory/canary.txt
READ-OK ~/.ssh/known_hosts
READ-OK ~/.ssh/id_ed25519
READ-OK ~/.config/gh/hosts.yml
...
CANARY-FILE-LEAKED
```

The `factory` profile extends the built-in `:workspace` profile, which is workspace-write: read everywhere, write in the worktree, `/tmp`, and `$TMPDIR`, network restricted.
The session file records the effective policy, so it can be verified per run; from the fixture's `turn_context`:

```
"active_permission_profile": {"id": "factory", "extends": ":workspace"},
"sandbox_policy": {"type": "workspace-write", "network_access": false, ...},
"permission_profile": {"file_system": {"entries": [{"path": {"kind": "root"}, "access": "read"},
  {"path": "<worktree>", "access": "write"}, {"path": "~/.software-factory", "access": "deny"}, ...]}, "network": "restricted"}
```

`codex sandbox -P factory <same -c flags> -- sh scripts/canary-probe.sh` applies the same profile without a model call, which made iterating on the policy free.

Evidence (spike step 3, parsed by `runAgent`):

```
"exitCode": 0, "outcome": "completed",
"sessionId": "01a1efae-7fd6-7ba1-a645-e89ed21cfbdb"     (thread.started.thread_id)
"requestedModel": "gpt-6-luna", "observedModel": "gpt-6-luna"   (turn_context.model in the session file)
"usage": { "inputTokens": 19356, "cachedInputTokens": 0, "cacheWriteInputTokens": 0, "outputTokens": 7, "reasoningOutputTokens": 0 }
```

The session file is `~/.codex/sessions/2026/11/18/rollout-2026-11-18T22-52-33-01a1efae-7fd6-7ba1-a645-e89ed21cfbdb.jsonl`; `findCodexSessionFile` globs `*/*/*/rollout-*-<threadId>.jsonl` after validating the id as a UUID.
Its `turn_context` also records `effort: "low"`, which a later step can use to validate observed effort.
Codex reports no cost, only tokens; `input_tokens` includes cached input.

## 4. Cancellation

Both CLIs run tool commands in a separate process group, so killing the CLI alone is not enough.
Manual runs, each with a tool `sleep` in flight:

| Signal to the CLI | Claude | Codex |
|---|---|---|
| SIGTERM | exits 143, tool process reaped | exits 143, tool `sleep 119` left running with ppid 1 |
| SIGKILL | exits 137, tool `sleep 118` left running with ppid 1 | not needed, already orphans on SIGTERM |
| `orca terminal close` (fallback) | `ptyKilled: true`, exit file `FACTORY_EXIT=143`, no orphan | not tested |

`terminateTree` in `src/dispatch/process.ts` therefore snapshots the descendant tree with `ps`, sends SIGTERM to the root and every descendant, waits up to 5 seconds for the root, re-collects children of survivors, and sends SIGKILL to anything still alive.
`runAgent` calls it on `AbortSignal` abort (outcome `cancelled`) and on `timeoutMs` (outcome `timed_out`).
Evidence through the module (spike step 4):

```
### 4 cancel claude
{ "toolProcessSeen": true, "before": ["37241 sleep 141"], "stopMs": 1098,
  "exitCode": 143, "outcome": "cancelled", "sessionId": "bc9af034-...", "orphansAfterCancel": [] }
### 4 cancel codex
{ "toolProcessSeen": true, "before": ["37566 rtk sleep 142", "37567 /bin/sleep 142"], "stopMs": 24,
  "exitCode": null, "outcome": "cancelled", "sessionId": "01a1efaf-6464-...", "orphansAfterCancel": [] }
```

Codex dies by the signal itself (`exitCode: null`, `signalCode` set), while Claude traps it and exits 143.
`bun test` covers the orphan case and the SIGKILL escalation with a fake CLI; removing either the tree SIGTERM or the SIGKILL sweep makes those tests fail.
Codex's shell tool returns to the model after about 30 seconds while the command keeps running in the background, so a long tool command does not mean a long-blocked turn.

## 5. Visibility in Orca

Direct run, checked while Claude's tool `sleep` was running in the spike worktree:

```
$ orca agent list --json      -> agents: bravent (codex chat), docs/design-v1 (claude chat), factory-step1-dispatch (claude chat)
$ orca worktree ps --json     -> spike-dispatch-1: "agents": []
$ orca terminal list --worktree path:<spike> --json -> only the worktree's default shell
```

After the runs, `orca search` finds both harnesses' direct sessions with a resume command:

```
$ orca search "canary-probe.sh" --path <spike> --fresh --json
  hits 1 | cd '<spike>' && claude --resume '62e9bcf4-2f81-4f39-b797-764256ba9764'
$ orca search "Reply with exactly: pong" --path <spike> --fresh --json
  hits 1 | cd '<spike>' && codex resume '01a1ef9b-32b6-7c62-9392-d41734b13f08'
```

Resuming a direct Claude session works, so the owner can pick up where a run stopped:

```
$ claude -p --resume 62e9bcf4-... --model haiku --restricted --tools "" "In one short sentence: what did step 3 print earlier?"
62e9bcf4-2f81-4f39-b797-764256ba9764 success | Step 3 printed `CANARY-envtest` followed by `rc=0`.
```

That session was the deliberate unstripped-env control run, which is why it saw a test canary value; the stripped runs in section 6 did not.

Fallback, the same CLI in an Orca terminal (`orca terminal create --worktree path:<spike> --title factory-spike-claude --command "<cmd>"`), where `<cmd>` is:

```
env -i HOME=... USER=... LOGNAME=... PATH=... SHELL=/bin/zsh TMPDIR=... LANG=en_US.UTF-8
  claude -p '<prompt>' --output-format stream-json --verbose <same flags> < /dev/null | tee <log>.jsonl;
  echo "FACTORY_EXIT=${pipestatus[1]}" > <log>.exit; exit
```

```
$ orca terminal wait --terminal term_2f5d... --for exit --timeout-ms 120000 --json
  "satisfied": true, "status": "exited", "exitCode": 0, "exitCause": {"kind": "unknown", "reason": "host_status_unavailable"}
$ cat <log>.exit            -> FACTORY_EXIT=0
$ tail -1 <log>.jsonl       -> result success 5d43a28e-... ['claude-haiku-5-5'] 0.00149654
```

While it ran, `orca terminal read` showed the raw stream-json in the tab, and `orca agent list` and `orca worktree ps` still did not list an agent.
The fallback costs, compared with direct spawn:

- The terminal's exit code is the shell's, so the CLI's exit code and result must travel through files.
- Orca types `--command` into the owner's interactive login shell (via an `orca-launch-*.sh` script), so the owner's zsh startup files run first and the prompt passes through shell quoting; issue text is untrusted, so the prompt would have to go through a file.
- Cancellation and timeouts go through `orca terminal close`, which is clean for Claude but adds a dependency on the Orca runtime being up for every stage.
- It still yields no attachable agent, only a raw-output tab.

Direct spawn plus a monitor tab gives the same live view without routing control through the terminal; proven with an existing run log:

```
$ orca terminal create --worktree path:<spike> --title "factory: monitor" --command "tail -n +1 -f <runId>.stdout.jsonl" --json
$ orca terminal read --terminal term_e739... --json   -> status running, tail shows the run's assistant and result events
$ orca terminal close --terminal term_e739... --json  -> ptyKilled: true
```

## 6. Credential canary

Setup: `~/.software-factory/canary.txt` holds `CANARY-<random>` (a first copy under `~/.factory` was removed after the state-dir rename; nothing else in `~/.factory` was touched).
The spike sets `process.env.FACTORY_CANARY = CANARY-<random2>` in the parent Bun process.
`scripts/canary-probe.sh` prints only status words and never file contents.
Baseline outside any sandbox (`FACTORY_CANARY=CANARY-baseline sh scripts/canary-probe.sh`): every file `READ-OK`, `CANARY-FILE-LEAKED`, `CANARY-ENV-LEAKED`, `NET-OPEN`, `KEYCHAIN-ITEM-VISIBLE`.

Through `runAgent` (spike step 6), the tool output of `sh ./canary-probe.sh` in each harness:

```
READ-DENIED ~/.software-factory/canary.txt
READ-DENIED ~/.software-factory/github-app.json
READ-DENIED ~/.ssh/known_hosts
READ-DENIED ~/.ssh/id_ed25519
READ-DENIED ~/.config/gh/hosts.yml
READ-DENIED ~/.config/gh/config.yml
READ-DENIED ~/Library/Keychains/login.keychain-db
READ-DENIED ~/.codex/auth.json
LIST-DENIED ~/.software-factory
LIST-DENIED ~/.ssh
LIST-DENIED ~/.config/gh
CANARY-FILE-HIDDEN
CANARY-ENV-HIDDEN
NET-BLOCKED curl-rc=56     (Claude: its proxy refused; stderr has "deny network-outbound example.com:443")
NET-BLOCKED curl-rc=6      (Codex: "Could not resolve host: example.com")
KEYCHAIN-ITEM-HIDDEN rc=44
```

The spike also searched each run's full stdout log for both canary strings: `fileCanaryInOutput: false` and `envCanaryInOutput: false` for both harnesses.
Direct attempts in the same runs: `printenv FACTORY_CANARY` returned `rc=1` in both, and Codex's `cat ~/.software-factory/canary.txt` failed with `Operation not permitted`.
Claude's Read tool is blocked separately from the Bash sandbox (dedicated run):

```
TOOL_USE Read {"file_path":"~/.software-factory/canary.txt"}
TOOL_RESULT is_error=true "<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>"
PERMISSION_DENIALS [{"tool_name":"Read", ...}]
outcome completed canaryInOutput false
```

Which control achieves what:

| Threat | Claude Code | Codex |
|---|---|---|
| Read a denied file from a shell command | `sandbox.filesystem.denyRead` (Seatbelt) | `permissions.factory.filesystem."<path>"="none"` with `default_permissions="factory"` |
| Read a denied file with a file tool | `permissions.deny` `Read(<path>)` and `Read(<path>/**)`, plus `blockReadsOutsideWorkingDirectories` | no separate file tool; the shell sandbox covers it |
| See a parent env secret | `agentEnv` allowlist in the spawn | `agentEnv` allowlist, plus `shell_environment_policy.inherit="core"` as a second layer |
| Reach the network | `sandbox.network.allowedDomains: []`, `WebFetch`/`WebSearch` denied | `:workspace` profile has network restricted; session shows `network_access: false` |
| Bypass the sandbox | `allowUnsandboxedCommands: false`, `failIfUnavailable: true` | no `-s`, `--ignore-rules` so user exec-policy rules cannot allow escalation, `codex exec` approval policy `never` |

The env allowlist is the primary env control for Claude: in a manual run that passed `FACTORY_CANARY` into Claude's env on purpose, `printenv` inside the sandbox printed it, so the Claude sandbox does not filter env by itself.
The same deliberate leak into Codex was hidden by `shell_environment_policy.inherit="core"`.
Inside Claude's sandbox the env gains proxy variables (`HTTP_PROXY`, `ALL_PROXY`, `SANDBOX_RUNTIME`, and others) that route traffic through its filtering proxy.

The deny-list (`DEFAULT_DENY_READ` in `src/dispatch/policy.ts`) is `~/.software-factory`, `~/.factory` (another tool's state dir on this machine), `~/.ssh`, `~/.config/gh`, `~/Library/Keychains`, `~/.codex/auth.json`, `~/.claude/.credentials.json`, `~/.aws`, `~/.config/gcloud`, `~/.docker/config.json`, `~/.gnupg`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`.
Denying all of `~/.codex` breaks Codex, because its sandbox helper re-execs `~/.local/bin/codex`, a symlink into `~/.codex/packages`:

```
ERROR codex_core::session: Failed to create session: failed to load AGENTS.md instructions for environment `local`:
fs sandbox helper failed with status exit status: 71: sandbox-exec: execvp() of '~/.local/bin/codex' failed: Operation not permitted
```

Nonexistent deny paths are accepted by both harnesses.

## Proposed design changes

These contradict or refine [design.md](../design.md); none is applied there yet.

1. Dispatch path.
   Replace "Plan step 1 confirms whether directly launched sessions appear in Orca for watching and intervening." and "If they do not, the factory runs the CLI inside an Orca-created terminal in that worktree." with:

   > Directly launched sessions are not listed as Orca agents; `orca search` indexes them afterwards with a resume command.
   > The factory keeps direct launch, may open a read-only Orca terminal that tails the run log for watching, and supports intervention as cancel plus resume.
2. Codex sandbox flag.
   Replace "Codex `workspace-write`" with "a Codex permission profile extending `:workspace` with deny entries, selected by `default_permissions`; never `-s`, which silently overrides it".
3. Hermetic Codex instructions.
   Codex loads the owner's global `~/.codex/AGENTS.md` even with `--ignore-user-config`; in the spike it made Codex prefix every command with `rtk`, which failed when `rtk` was not on `PATH`.
   Proposal: give the factory its own `CODEX_HOME` under `~/.software-factory/codex-home`, logged in once by the owner with `CODEX_HOME=... codex login`, so no owner instructions or config reach factory runs and agents still cannot read its `auth.json` (the whole state dir is denied).
   This needs an owner action and is not done in this step.
4. Project instructions under Claude `--restricted`.
   `--restricted` does not load the worktree's `CLAUDE.md`: with the same prompt, one run answered `NONE` and another found the codeword only by calling Read on `CLAUDE.md` itself.
   Codex loaded the worktree's `AGENTS.md` both times.
   Proposal: the factory passes the project's `AGENTS.md` to Claude explicitly (for example `--append-system-prompt-file`), decided in step 3 or 4.
5. Owner customizations still visible to Claude.
   Under `--restricted`, the `system/init` event still lists the owner's user skills, plugins, and slash commands, and the Bash tool sources a snapshot of the owner's zsh (`~/.claude/shell-snapshots`).
   Proposal: step 4 decides how factory skills are supplied and whether `--disable-slash-commands` or an explicit plugin dir is needed for hermetic runs.
6. Session identity and crash recovery.
   Claude takes the factory's attempt id as `--session-id`; Codex assigns its thread id and reveals it only in `thread.started`.
   The factory should name logs by attempt id (as `runAgent` does) and recover the Codex thread id from the log.
   Because stdout goes to a file, an agent survives a factory crash and runs to completion; step 9 must find and adopt or kill it by attempt id.
7. Per-run policy verification.
   Codex's session `turn_context` records the effective permission profile, so the factory can assert the deny entries and `network_access: false` after each run instead of trusting the flags.

## Module

- `src/dispatch/index.ts` `runAgent(spec)`: spawns the CLI in the worktree with the stripped env and stdin from `/dev/null`, writes stdout and stderr to `<logDir>/<runId>.*`, handles abort and timeout, and returns `RunResult` (session id, exit code, signal, outcome, requested and observed model, usage or null, final text).
- `src/dispatch/claude.ts` and `src/dispatch/codex.ts`: the proven flags and the parsers.
- `src/dispatch/policy.ts`: deny-list and env allowlist.
- `src/dispatch/process.ts`: process-tree termination.
- `src/orca/worktree.ts`: worktree create and remove.
- Usage is kept per harness; normalizing it and pricing it belong to plan step 8.
- The network policy is off only; install stages that need network come with a later step.

## Tests

`bun test` runs 29 tests in `test/`.
Parser tests use fixtures captured from the spike runs in `test/fixtures` (Claude stream, Codex JSONL, and a Codex session file trimmed to its metadata, turn context, and token records), with home paths and personal skill and plugin lists scrubbed and account ids replaced.
`test/run.test.ts` drives `runAgent` against fake `claude` and `codex` executables to cover completion, observed-model lookup, env stripping, abort with an orphan-prone child, timeout, and SIGKILL escalation.

## Tooling note

`typescript` 5.8.3, `@types/bun` 1.2.10, and `@types/node` 22.15.3 are pinned dev dependencies so `bun run typecheck` works.
They are type-only and never shipped; `@types/node` is pinned because the latest version drops the `AbortSignal` members that `bun-types` 1.2.10 relies on.
