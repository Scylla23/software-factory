# Spike 01 - Dispatch and Orca visibility

Plan step: [v1-plan.md](../v1-plan.md) step 1.
Date: 2026-11-18.
Versions: Orca 1.4.262, Claude Code 2.1.325, codex-cli 0.169.0, Bun 1.2.10, macOS (Darwin 25.6.0).
Models: Claude `haiku` (resolved to `claude-haiku-5-5`), Codex `gpt-6-luna`, effort `low`; total spend was a few cents.
Home paths are shown as `~` and spike worktree names are shortened.
A repair round after review changed the deny-list, process handling, executable resolution, log location, and parsing; [section 7](#7-repair-round) has what changed and its evidence, and sections 1 to 6 are updated where behavior changed.
A second round implemented the owner's decisions on dedicated harness homes, the monitor tab, and explicit project instructions; [section 8](#8-decisions-implemented) has them and their evidence.

## Verdict

- Dispatch path: the factory spawns `claude -p` and `codex exec --json` directly (`node:child_process` `spawn` as a new process group) inside the Orca-created worktree, implemented in `src/dispatch`.
- A directly launched session is not visible live in Orca: it is absent from `orca agent list` and from the worktree's agents in `orca worktree ps`, so it cannot be attached.
- After the fact, `orca search` indexes both harnesses' direct sessions and returns a working resume command, so the owner can inspect and continue a session.
- The Orca-terminal fallback works (proven below), but it does not make the run an Orca agent either: `orca agent list` still does not list it, and it only adds a raw-output tab.
- Because the fallback buys no attachability and costs robustness and security, the recommendation is direct spawn plus an optional read-only Orca monitor tab that tails the run log, and intervention by cancel plus resume.
- This contradicts the design's fallback rule; see [Proposed design changes](#proposed-design-changes).

## 1. Worktree through the orca CLI

`src/orca/worktree.ts` shells out (now through the trusted `orca` from `DispatchConfig`, naming the main checkout with `--repo path:<checkout>`) to `orca worktree create --name <n> --no-parent --setup skip --json` and `orca worktree rm --worktree id:<id> --force --delete-branch --json`.
Run by the spike driver `scripts/spike-dispatch.ts`, which the repair round deleted; the tests and the verification in section 7 replace it:

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

Arguments built by `claudeArgs` in `src/dispatch/claude.ts`:

```
CLAUDE_CONFIG_DIR=~/.software-factory/claude-home \
claude -p --output-format stream-json --verbose --model <model> --effort <effort> --session-id <runId>
  --restricted --tools Bash,Read,Edit,Write,Glob,Grep --strict-mcp-config --disable-slash-commands
  --permission-mode dontAsk --permission-prompts none --settings '<json>'
  [--append-system-prompt-file <logDir>/<runId>.instructions.md] -- <prompt>
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

Arguments built by `codexArgs` in `src/dispatch/codex.ts`:

```
CODEX_HOME=~/.software-factory/codex-home \
codex exec --json --ignore-user-config --ignore-rules -m <model> -c model_reasoning_effort="<effort>"
  -c 'permissions={factory={extends=":workspace", filesystem={"~/.software-factory"="none",...,"~/.codex/packages"="read"}}}'
  -c 'default_permissions="factory"'
  -c 'shell_environment_policy.inherit="core"'
  -c allow_login_shell=false
  -c 'web_search="disabled"' -c skills.include_instructions=false -c skills.bundled.enabled=false
  -c features.plugins=false -c features.remote_plugin=false -c features.apps=false
  -c features.hooks=false -c features.image_generation=false
  -c project_doc_max_bytes=0 [-c 'developer_instructions="<project instructions>"']
  -C <worktree> -- <prompt>
```

Section 8 explains the flags after `allow_login_shell`.

stdin is `/dev/null` (`stdin: "ignore"`); Codex prints `Reading additional input from stdin...` to stderr and proceeds.
`--ignore-user-config` keeps auth working; auth comes from `$CODEX_HOME/auth.json`, the factory's own login.

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

`terminateTree` in `src/dispatch/process.ts` handles this, as rewritten in the repair round:

1. The CLI is spawned with `detached: true`, so it is a session and process-group leader and its pgid equals its pid.
2. Freeze: SIGSTOP the root through its child handle first, then repeatedly snapshot with `ps`, adopt new descendants and group members, and SIGSTOP them, for up to 5 rounds or until a round finds nothing new.
3. SIGTERM then SIGCONT to the handle, every tracked process, and the group, then wait up to 5 seconds for the root.
4. Re-snapshot (always including the root), adopt children forked by TERM handlers and group members reparented to launchd, and SIGKILL them all.
5. Bounded waits throughout; any process still alive is returned as `cleanup.survivors`, and snapshot or signal failures as `cleanup.errors`, both also surfaced in `RunResult.diagnostics`.

A process is tracked as (pid, `ps` start time) and re-verified against a fresh snapshot before every signal, so a recycled pid is never signalled.
`ps` runs by absolute path with `LC_ALL=C TZ=UTC PATH=/usr/bin:/bin`.
A group member counts as ours only while the root is unreaped or if it started no later than the root's exit, because a pgid is only reused after the group empties.
Darwin's `killpg` returns EPERM while the group holds a zombie; that is ignored for the group signal, because every member is also signalled individually.
Residual gap: macOS has no cgroups, so a tool that calls `setsid()` and whose parent exits before the first snapshot ends up in its own session under launchd and is not found.
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
`bun test` covers, with a fake CLI: the orphan case, a child forked in the TERM handler, a child reparented to launchd inside the group, SIGKILL escalation, a failing `ps`, pid reuse, a recycled group, and start-time parsing under a non-UTC `TZ`.
Repeated with the real CLIs after the repair (section 7): both cancelled with no surviving tool `sleep`, `survivors: []`, `errors: []`.
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

`scripts/canary-probe.sh` prints only status words and paths, never file contents, and has four modes:

- `--setup` writes `FACTORY-CANARY-<random>` to `~/.software-factory/canary.txt` (mode 600) and plants the same kind of string in fake transcripts at `~/.claude/projects/-factory-canary/canary.jsonl` and `~/.codex/sessions/factory-canary/canary.jsonl`.
- `--baseline`, outside any sandbox, proves every target exists and is readable, the planted canaries are found by `grep`, and the network is up, so a later DENIED is meaningful.
- The default mode runs inside the agent sandbox.
- `--cleanup` removes the planted transcripts.

Each target is classified from `cat`'s error under `LC_ALL=C`: READABLE is a leak, `Operation not permitted` or `Permission denied` is DENIED, `No such file or directory` is MISSING, and anything else is UNKNOWN.
MISSING and UNKNOWN are inconclusive, never a pass.
A positive control must read the probe itself and read and `grep` a fresh canary in `$TMPDIR`, or every DENIED could be a broken probe.
The indirect check runs `grep -rIlE 'FACTORY-CANARY-[0-9a-f]{32}'` over `~/.software-factory`, `~/.claude/projects`, and `~/.codex/sessions`; any match is a leak.
It also checks `FACTORY_CANARY` in the env and egress to `https://example.com`.
Exit 0 is a pass, 1 a leak, and 2 inconclusive; a leak wins.
The keychain is probed only as the `login.keychain-db` file: `security find-generic-password` returns rc 44 both for an absent item and for one the sandbox hides, so it cannot prove denial and was dropped.

Baseline on this machine: all targets READABLE (14 in the repair round, 23 after section 8), `INDIRECT-CANARIES-FOUND 3`, `NET-OPEN`, `BASELINE-OK`.
The default mode run outside any sandbox with `FACTORY_CANARY` set reports `INDIRECT-LEAK` for all three canaries, `ENV-LEAK FACTORY_CANARY`, `NET-OPEN`, and `RESULT LEAK`, which shows the probe detects each leak class.

Through `runAgent` with the real CLIs (repair-round verification, section 7), `sh ./canary-probe.sh; echo EXIT=$?` printed the same in both harnesses:

```
CONTROL-OK
DENIED ~/.software-factory/canary.txt
DENIED ~/.ssh/known_hosts
DENIED ~/.ssh/config
DENIED ~/.config/gh/hosts.yml
DENIED ~/.codex/auth.json
DENIED ~/.codex/history.jsonl
DENIED ~/.codex/state_5.sqlite
DENIED ~/.claude/history.jsonl
DENIED ~/Library/Keychains/login.keychain-db
DENIED ~/Library/Application Support/orca/orca-runtime.json
DENIED ~/.docker/config.json
DENIED ~/.npmrc
DENIED ~/.claude/projects/-factory-canary/canary.jsonl
DENIED ~/.codex/sessions/factory-canary/canary.jsonl
INDIRECT-HIDDEN
ENV-HIDDEN
NET-BLOCKED
RESULT PASS
EXIT=0
```

Claude's tool output also carried `deny network-outbound example.com:443 (user denied)` from its sandbox.

The original spike (before the repair) ran an older probe through both harnesses with the same result for its narrower target list, with `FACTORY_CANARY` set in the parent Bun process.
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

The deny-list is `MANDATORY_DENY_READ` in `src/dispatch/policy.ts`, applied to every run of both harnesses.
`RunSpec.extraDenyRead` can only add to it; `effectiveDenyRead` merges, validates (absolute or `~/` only), and dedupes.

- Factory state, which now includes both harness homes with their auth and the factory's own transcripts: `~/.software-factory`, and `~/.factory` (another tool's state dir on this machine).
- Credential stores: `~/.ssh`, `~/.config/gh`, `~/Library/Keychains`, `~/.aws`, `~/.config/gcloud`, `~/.docker/config.json`, `~/.gnupg`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`.
- The owner's own harness homes, whole: `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.agents` (the owner's cross-harness skills), and `~/Library/Application Support/orca`.

The repair round denied only the history inside `~/.claude` and `~/.codex`, because the CLIs used those homes.
With dedicated homes neither CLI needs them, so the round in section 8 denies them whole, which also covers the owner's settings, instructions, skills, and plugins; the owner's history there is still denied.
Codex gets `~/.codex/packages` back as read-only (`CODEX_READ_EXCEPTIONS` in `codex.ts`), because its sandbox helper re-execs the Codex binary installed there; the more specific entry wins, and the dir holds only installed releases.
Without the carve-out, denying `~/.codex` broke Codex in the original spike:

```
ERROR codex_core::session: Failed to create session: failed to load AGENTS.md instructions for environment `local`:
fs sandbox helper failed with status exit status: 71: sandbox-exec: execvp() of '~/.local/bin/codex' failed: Operation not permitted
```

With it, `codex sandbox` under the profile reads the binary while `~/.codex/config.toml`, `~/.codex/AGENTS.md`, and a listing of `~/.codex` fail with `Operation not permitted`.
Both CLIs start and run Bash with everything denied, including their own homes under the denied state dir: the CLI processes read their homes unsandboxed, and only tool commands are confined.
Both harnesses accept `*` globs in deny entries (Codex records one as a `glob_pattern` entry).

Nonexistent deny paths are accepted by both harnesses.

## 7. Repair round

Fixes after review, with how they were verified.

### Executables

`loadDispatchConfig` resolves `claude` and `codex` once at startup from `~/.local/bin`, `/opt/homebrew/bin`, then `/usr/local/bin` (never `$PATH`), and `ps` as `/bin/ps`.
Each is canonicalized and must be a regular executable file owned by root or the user, not group or world writable, and outside every temp root and agent write root.
On this machine they resolve to `~/.local/share/claude/versions/2.1.325`, `~/.codex/packages/standalone/releases/0.169.0-aarch64-apple-darwin/bin/codex`, and `/bin/ps`.
Because the canonical path names a version, a CLI auto-update that deletes the old version makes the next spawn fail with a diagnostic until the config is reloaded.
`runAgent` refuses an executable whose canonical path is inside the worktree.
The agent's `PATH` keeps only absolute entries.

### Managed settings

Claude managed settings outrank `--settings` and survive `--restricted`, so `runAgent` refuses a Claude dispatch while any of these exists, whatever it holds: `/Library/Application Support/ClaudeCode/managed-settings.json`, the `/Library/Application Support/ClaudeCode/managed-settings.d` directory, `/Library/Managed Preferences/com.anthropic.claudecode.plist`, and the per-user plist under `/Library/Managed Preferences/<user>/`.
A location that cannot be checked counts as existing, and there is no way to accept one (repair round 2 removed the sha256 acceptance).
On this machine none exist: there is no `/Library/Application Support/ClaudeCode`, no `/Library/Managed Preferences`, and `defaults read com.anthropic.claudecode` reports the domain does not exist.

### Logs

The log dir is canonicalized and must be under the state root (`~/.software-factory` by default) and outside the worktree, temp roots, and agent write roots.
Log files are opened with `O_CREAT | O_EXCL | O_NOFOLLOW` and mode 600, so a reused attempt id or a planted symlink fails before anything starts.
Logs are always kept.

### Parsing

`readJsonl` streams the log from disk with an 8 MiB bound per record and reports each bad line as a truncated final record or as interior corruption.
Any bad line or malformed usage makes Codex usage unknown (`null`) and the run not succeeded, because the lost line could have been a `turn.completed` or `turn.failed`; more than one Claude `result` does the same for Claude.
A malformed thread id or a missing or unreadable rollout keeps the outcome, logs, and usage, and only makes the observed model unknown with a diagnostic.

### Cancellation

An already-aborted signal throws before spawn.
Termination is rewritten as described in section 4.
A bug found on the way: `bun test` forces `TZ=UTC`, and `ps` printed local start times that were parsed as UTC, which skewed the group-ownership check by hours and let a child forked in a TERM handler survive; `ps` now runs with `TZ=UTC`, and a test runs the check under `TZ=America/Los_Angeles`.

### Removed

The spike driver `scripts/spike-dispatch.ts` was deleted, which also removes its review findings.

### Verification

Verification with the real CLIs (`haiku` and `gpt-6-luna` at effort `low`), through `runAgent` with `loadDispatchConfig({ agentWriteRoots: [~/orca/workspaces] })`, in a fresh Orca worktree removed afterwards, logs under `~/.software-factory/runs` removed afterwards:

```
claude  outcome completed  observedModel claude-haiku-5-5  usage.totalCostUsd 0.00219  diagnostics []  probe RESULT PASS
codex   outcome completed  observedModel gpt-6-luna        usage.outputTokens 425       diagnostics []  probe RESULT PASS
claude  cancel during `sleep 313`: outcome cancelled, signal SIGTERM, cleanup {survivors: [], errors: []}, no sleep left
codex   cancel during `sleep 313`: outcome cancelled, signal SIGTERM, cleanup {survivors: [], errors: []}, no sleep left
```

Before the repair, SIGTERM to Codex left its tool `sleep` running under launchd (section 4); signalling the group now covers it.
The planted transcript canaries were removed with `--cleanup`; `~/.software-factory/canary.txt` stays.

## 8. Decisions implemented

The owner decided the three open questions, recorded in [design.md](../design.md) (commit fb27940).
All real runs below went through `runAgent` with `loadDispatchConfig({ agentWriteRoots: [~/orca/workspaces] })`, `haiku` and `gpt-6-luna` at effort `low`, each in a fresh Orca worktree removed afterwards.

### Dedicated harness homes

Every run sets `CLAUDE_CONFIG_DIR=~/.software-factory/claude-home` for Claude or `CODEX_HOME=~/.software-factory/codex-home` for Codex.
The value comes from `DispatchConfig.harnessHomes`, never from the parent env, and `agentEnv` adds it after the allowlist.
`loadDispatchConfig` and every `runAgent` check that the home is a canonical directory under the state root, owned by the user, with mode 700.
The observed Codex model is now read from `$CODEX_HOME/sessions`.
Factory transcripts land in the dedicated homes (`claude-home/projects/...`, `codex-home/sessions/...`), not in the owner's.

A dedicated home alone did not make Codex hermetic.
A run with only `CODEX_HOME` set listed the owner's skills from `~/.agents/skills` (`gh-axi`, `orca-cli`, `bravent-caveman`, and others), which Codex reads from `$HOME`, plus the account's remote plugins (Figma, Linear, and others), and offered the hosted `web__run` tool.
`web__run` runs on the provider's side, so the sandbox's network block does not stop it; the dispatch before this round exposed it too.
Each flag was checked against the session rollout, counting mentions of skill and tool names:

| Flags added | Owner skills (`gh-axi`) | Plugin skills (`figma`) | `web__run` |
|---|---|---|---|
| none | 6 | 136 | present |
| `features.plugins=false`, `remote_plugin=false`, `apps=false` | 6 | 0 | present |
| plus `skills.include_instructions=false`, `skills.bundled.enabled=false` | 0 | 0 | present |
| plus `web_search="disabled"` | 0 | 0 | absent |

`features.skip_host_skill_discovery=true` did not remove the owner's skills.
`features.hooks=false` and `features.image_generation=false` are also set, since the factory uses neither.
Turning skill listings off also hides any skills the factory later installs in `codex-home/skills`, so plan step 4 must supply factory skills another way or revisit this flag.
Codex still offers its multi-agent tools (`spawn_agent`); its subagents run under the same profile.

For Claude, `--disable-slash-commands` drops the built-in skills and commands as well.
`system/init` in a run before that flag listed only Claude Code's built-ins (`deep-research`, `dataviz`, `code-review`, and others), none of the owner's `~/.claude/skills`; with it:

```
"slash_commands": [], "skills": [], "mcp_servers": [], "tools": ["Bash","Edit","Glob","Grep","Read","Write"],
"plugins": [cc-plugin-agents-md, cc-plugin-telemetry, cc-plugin-privacy, cc-plugin-plugin-authoring, all "path": "builtin"]
```

The built-in plugins cannot be removed by a flag; `cc-plugin-agents-md` did not load the worktree's `AGENTS.md` (codeword test below).
The owner's `~/.claude/settings.json` defines 16 hook events; the Claude streams show no hook events.
Codex no longer prefixes commands with `rtk`: the owner-check run executed `/bin/zsh -c 'echo factory-hi'`, and its rollout has no mention of `rtk`.
Asked for every skill, plugin, and slash command it knows, Codex answered NONE for all three.

Codex still resolves to `~/.codex/packages/standalone/releases/0.169.0-aarch64-apple-darwin/bin/codex` and runs with the new `CODEX_HOME`; the binary is self-contained, and its sandbox helper re-execs it through the `~/.codex/packages` carve-out.
`orca` resolves to `/Applications/Orca.app/Contents/Resources/bin/orca` through `/usr/local/bin/orca`.

The canary probe now also targets the factory homes (`codex-home/auth.json`, `claude-home/.claude.json`), `~/.software-factory/github-app.json`, the owner's `~/.codex/config.toml`, `~/.codex/AGENTS.md`, `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, `~/.claude.json`, and `~/.agents/.skill-lock.json`, and its indirect search covers all of `~/.claude` and `~/.codex`.
Both harnesses: all 23 targets DENIED, `INDIRECT-HIDDEN`, `ENV-HIDDEN`, `NET-BLOCKED`, `RESULT PASS`.
Cancelling each during a tool `sleep 313` left no `sleep`, with `survivors: []` and `errors: []`.

### Monitor tab

`RunSpec.monitor: { agent }` opens an Orca terminal in the run's worktree, titled `factory: <agent> <runId>`, that runs `tail -n +1 -f <stdout log>`, and closes it when the run ends.
It opens in the background after spawn, every `orca` call is bounded (15 seconds), and any failure only adds a `monitor:` diagnostic; a failing, missing, or hung `orca` leaves the outcome, usage, and result unchanged (tests).
The agent label must match `[A-Za-z0-9._-]{1,64}`, and paths are single-quoted, because Orca types the command into the owner's interactive login shell.
`orca` runs by its trusted path with a fixed minimal env (`HOME`, `USER`, `LOGNAME`, `PATH=/usr/bin:/bin`, `LANG`), which is enough for it to reach the runtime.

`--title` only sets Orca's `paneTitle`; the tab's live `title` follows the shell, and the owner's zsh set it to `tail`.
The command therefore starts with an OSC 0 escape that sets the live title too.
Evidence from `orca terminal list` during and after each codeword run:

```
during: [["..1795027397212", null], ["factory: verifier 99fc83a8-...", "factory: verifier 99fc83a8-..."]]   (title, paneTitle)
after:  [["..1795027397212", null]]
```

### Project instructions

`RunSpec.instructionFiles` takes the project's `AGENTS.md`, and `CLAUDE.md` if present (`projectInstructionFiles(checkout)` lists them).
`runAgent` reads them before spawn and refuses any that resolve into the worktree or a temp root, because a later run in the same worktree would otherwise take its instructions from what an earlier agent wrote.
They are combined, once per real file, into one `<project_instructions>` text of at most 256 KiB, which is kept as `<logDir>/<runId>.instructions.md`.

- Claude gets that file with `--append-system-prompt-file`; `--restricted` already keeps Claude from loading the worktree's `CLAUDE.md` or `AGENTS.md` on its own.
- Codex gets the same text as `-c developer_instructions="<text>"`, encoded as a TOML basic string, and `-c project_doc_max_bytes=0` always turns off its own `AGENTS.md` discovery, so the worktree copy can never load next to the explicit one or diverge from it.
- Codex has no instructions-file option that appends: `model_instructions_file` replaces its base instructions, so argv it is, which is why the text is capped well under macOS's 1 MiB argv limit.

Codeword test: the worktree had `AGENTS.md` with OSPREY and `CLAUDE.md` with HERON, and the explicit files said PELICAN and CORMORANT.
Asked without tools for every codeword in their instructions, both harnesses answered exactly:

```
PELICAN
CORMORANT
```

Claude made no tool calls, and the Codex rollout contains PELICAN and CORMORANT but not OSPREY.
Bun 1.2.10's `Bun.TOML.parse` decodes `\t` as a form feed, so tests check the TOML encoding against the basic-string grammar instead.

## Proposed design changes

These contradict or refine [design.md](../design.md); 1, 3, and 4 are now decided there (commit fb27940), and 2 is reflected in its build section.

1. Dispatch path.
   Replace "Plan step 1 confirms whether directly launched sessions appear in Orca for watching and intervening." and "If they do not, the factory runs the CLI inside an Orca-created terminal in that worktree." with:

   > Directly launched sessions are not listed as Orca agents; `orca search` indexes them afterwards with a resume command.
   > The factory keeps direct launch, may open a read-only Orca terminal that tails the run log for watching, and supports intervention as cancel plus resume.
2. Codex sandbox flag.
   Replace "Codex `workspace-write`" with "a Codex permission profile extending `:workspace` with deny entries, selected by `default_permissions`; never `-s`, which silently overrides it".
3. Hermetic Codex instructions (decided yes, implemented in section 8).
   Codex loads the owner's global `~/.codex/AGENTS.md` even with `--ignore-user-config`; in the spike it made Codex prefix every command with `rtk`, which failed when `rtk` was not on `PATH`.
   Proposal: give the factory its own `CODEX_HOME` under `~/.software-factory/codex-home`, logged in once by the owner with `CODEX_HOME=... codex login`, so no owner instructions or config reach factory runs and agents still cannot read its `auth.json` (the whole state dir is denied).
   The owner logged in to both dedicated homes; [design.md](../design.md) records the decision.
4. Project instructions under Claude `--restricted` (decided yes, implemented in section 8).
   `--restricted` does not load the worktree's `CLAUDE.md`: with the same prompt, one run answered `NONE` and another found the codeword only by calling Read on `CLAUDE.md` itself.
   Codex loaded the worktree's `AGENTS.md` both times.
   Proposal: the factory passes the project's `AGENTS.md` to Claude explicitly (for example `--append-system-prompt-file`), decided in step 3 or 4.
5. Owner customizations still visible to Claude (resolved in section 8 by the dedicated home and `--disable-slash-commands`).
   Under `--restricted`, the `system/init` event still lists the owner's user skills, plugins, and slash commands, and the Bash tool sources a snapshot of the owner's zsh (`~/.claude/shell-snapshots`, now denied to tools but still sourced by Claude itself).
   Proposal: step 4 decides how factory skills are supplied and whether `--disable-slash-commands` or an explicit plugin dir is needed for hermetic runs.
6. Session identity and crash recovery.
   Claude takes the factory's attempt id as `--session-id`; Codex assigns its thread id and reveals it only in `thread.started`.
   The factory should name logs by attempt id (as `runAgent` does) and recover the Codex thread id from the log.
   Because stdout goes to a file, an agent survives a factory crash and runs to completion; step 9 must find and adopt or kill it by attempt id.
7. Per-run policy verification.
   Codex's session `turn_context` records the effective permission profile, so the factory can assert the deny entries and `network_access: false` after each run instead of trusting the flags.

## Module

- `src/dispatch/index.ts` `runAgent(spec, config)`: checks the spec, the signal, the executable, managed settings, and the log location before anything starts; spawns the CLI in the worktree with the stripped env and stdin from `/dev/null`; writes stdout and stderr to `<logDir>/<runId>.*`; handles abort and timeout; and returns `RunResult` (session id, exit code, signal, outcome, requested and observed model, usage or null, final text, diagnostics, cleanup report).
- `src/dispatch/config.ts`: `loadDispatchConfig`, executable resolution, managed-settings check, and log creation.
- `src/dispatch/claude.ts` and `src/dispatch/codex.ts`: the proven flags and the parsers.
- `src/dispatch/jsonl.ts`: the bounded streaming JSONL reader.
- `src/dispatch/policy.ts`: deny-list, env allowlist, and the harness home variable.
- `src/dispatch/instructions.ts`: reading and combining the project's instruction files.
- `src/dispatch/process.ts`: process-group spawn and termination.
- `src/orca/cli.ts`: bounded `orca` calls with a fixed minimal env.
- `src/orca/worktree.ts`: worktree create and remove.
- `src/orca/monitor.ts`: the optional read-only monitor tab.
- Usage is kept per harness; normalizing it and pricing it belong to plan step 8.
- The network policy is off only; install stages that need network come with a later step.

## Tests

`bun test` runs 99 tests in `test/`.
Parser tests use fixtures captured from the spike runs in `test/fixtures` (Claude stream, Codex JSONL, and a Codex session file trimmed to its metadata, turn context, and token records), with home paths and personal skill and plugin lists scrubbed and account ids replaced.
`test/run.test.ts` drives `runAgent` and `terminateTree` against a fake CLI (`test/helpers.ts`) whose behavior is chosen by its last argument; the fake is passed through `DispatchConfig.executables`, never `PATH`.
`test/config.test.ts` covers executable trust, harness home checks, managed settings, and log creation; `test/policy.test.ts` covers the deny-list merge for both harnesses, the Codex carve-out and hermetic flags, and the env allowlist.
`test/monitor.test.ts` drives the monitor against a fake `orca`, including a failing, missing, and hung one; `test/instructions.test.ts` covers reading, refusing, and passing project instructions identically to both harnesses.
Each repair-round fix, and the main fixes of section 8, was checked by reverting it and seeing its test fail.
Test state lives under `test/.state` (ignored), because log dirs must not be under a temp root.

## Tooling note

`typescript` 5.8.3, `@types/bun` 1.2.10, and `@types/node` 22.15.3 are pinned dev dependencies so `bun run typecheck` works.
They are type-only and never shipped; `@types/node` is pinned because the latest version drops the `AbortSignal` members that `bun-types` 1.2.10 relies on.
