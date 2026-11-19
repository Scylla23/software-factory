# Spike 02 - Verification

Plan step: [v1-plan.md](../v1-plan.md) step 2.
Date: 2026-11-19, first run and repair round.
Versions: Orca 1.4.262, macOS 26.6.2 (Darwin 25.6.0), Bun 1.2.10, git 2.x from `/usr/bin/git`, Claude Code 2.1.325, codex-cli 0.169.0.
No model calls were made.
Home paths are shown as `~`, and the preview root under `$TMPDIR` is shown as `<tmp>`.

## Verdict

Sections 1 to 7 record the first run.
[Section 8](#8-repair-round) records the repair round after review, with the owner's decisions Q50 to Q53; where they differ, section 8 is current.

- Project commands (setup, preview, and later test, lint, and typecheck) run under a Seatbelt profile the factory writes itself and applies with `/usr/bin/sandbox-exec` (`src/verify/sandbox.ts`).
  Reads are closed by default (Q51), setup reaches the network only through a factory egress proxy that dies with the phase (Q50), and the preview may connect to its own port only.
- Evidence stays on the factory host in `~/.software-factory/evidence/<attempt>` (Q53).
  The PR gets one text-only comment from the App per attempt, redacted, with a marker that names the captured revisions, published only when every check passed and the PR still has the recorded base and head.
- The preview starts from an exact commit in a per-attempt directory under the state root, on a leased port, and tears down with `noKnownSurvivors: true`, the worktree and home removed.
- The browser runs in a fresh isolated Orca profile per verification, owned and deleted by the factory; it holds no GitHub session, and every capture is bound to the preview's origin and live server.
  Orca cannot restrict the page's requests to that origin, so browser egress during capture is unrestricted and recorded as such (Q52).
- Stabilized screenshots are byte-identical across two captures at both viewports and across runs, and before and after differ.
- Fixture PRs (draft, opened by the App): https://github.com/Scylla23/factory-pilot/pull/1 (first run) and https://github.com/Scylla23/factory-pilot/pull/2 (repair round, base at the fixture's first commit).

## 1. Preview from an exact commit

`startPreview` in `src/verify/preview.ts`:

1. `materializeCommit` (`src/verify/materialize.ts`) resolves the full commit id with `git rev-parse --verify <sha>^{commit}` and runs `git -c core.hooksPath=/dev/null worktree add --detach -- <root>/preview-<id8> <sha>` through the trusted git runner from step 1, then checks that `HEAD` is the requested commit.
   Hooks are off because `worktree add` runs `post-checkout`, which would execute repo code in the factory process; a test plants such a hook and shows a plain checkout runs it and materialization does not.
   The checkout must be outside every agent-writable root, like the instructions repo of step 1, because its git config decides what runs during checkout.
2. A private home `<root>/preview-<id8>.home` (mode 700, with `tmp/`) becomes `HOME` and `TMPDIR`, so installs get an empty cache and never see the owner's dotfiles.
3. Each declared setup command runs sandboxed with outbound network (section 2), supervised with a bound.
   After each one, the worktree and the home are swept for leftovers; a nonzero exit, a timeout, or anything left running fails the preview.
4. `taskPort` picks the port: a start derived from the task key by SHA-256 within the configured range, then the next free port, wrapping.
   The same task gets the same port while it is free, which keeps logs readable; freedom is only a hint, so step 6 below checks who listens.
5. The preview command runs sandboxed with only its port (section 2), `PORT` in its env, supervised with a maximum lifetime.
6. `waitReady` polls `http://127.0.0.1:<port><readyPath>` every 200 ms, each probe bounded to 2 seconds, until a 200, the process exiting, or the timeout; redirects are not followed.
7. `listenerOwnership` lists the listeners on the port with `lsof` and requires each to be the preview's root or a descendant (step 1's `Tracker`), so evidence can never come from a stranger's server that won the port.
8. `stop()` aborts supervision (step 1's freeze, SIGTERM, SIGKILL `terminateTree`), sweeps the worktree and the home with step 1's `sweepWorktree`, and only when nothing was found removes the worktree (`git worktree remove --force --force`, then `prune`) and the home; otherwise both stay for inspection with the reasons in `quarantineReasons`.

`Preview.run(argv, { network, name, timeoutMs })` runs one more command in the preview's worktree under the same sandbox, used here for the probes and meant for step 5's checks.
Its sweep spares the live preview by (pid, start time) identity with its descendants, through a new `spare` option of `sweepWorktree`.
Without that, the first probe run beside the preview killed the preview server, whose parent is the factory and whose cwd is the worktree, so the next page load failed with `ERR_CONNECTION_REFUSED`; a test now runs a command that leaves a detached process beside the preview and shows the leftover is killed and the preview still answers.

Real run (`scripts/spike-verify.ts`, section 7):

```
### preview 683a16be19ae ready on http://127.0.0.1:4189 in 693ms (spawn to 200: 270ms), worktree <tmp>/factory-previews-wlHecR/preview-7384f8b5
setup log:  | 1 package installed [133.00ms]
### stop before preview: {"cleanup":{"survivors":[],"errors":[]},"noKnownSurvivors":true,"quarantineReasons":[],"removed":true}
### preview 4a5de0545bb0 ready on http://127.0.0.1:4134 in 653ms (spawn to 200: 273ms), worktree <tmp>/factory-previews-wlHecR/preview-1d72ee0b
### stop after preview: {"cleanup":{"survivors":[],"errors":[]},"noKnownSurvivors":true,"quarantineReasons":[],"removed":true}
```

The factory-controlled checkout is `~/orca/projects/factory-pilot`, created by this spike with `git init` and filled by `fetchCommits` (`src/github/fetch.ts`), which fetches exact commits with an installation token passed to git only as an `http.extraHeader` in `GIT_CONFIG_*` environment variables, never in argv, the remote URL, or a config file, and keeps each fetched commit alive under `refs/factory/commits/<sha>`.
After the fetch, `grep -rlE 'ghs_|x-access-token' .git` found nothing and `.git/config` has no remote.
The preview root in the spike is a fresh `mkdtemp` under `$TMPDIR`; `/tmp` itself is refused because it is world-writable.

Tests (`test/verify-preview.test.ts`, `test/verify-materialize.test.ts`, `test/verify-port.test.ts`): the exact commit is served after setup and everything is gone after `stop()`; a failing setup, a setup that leaves a detached process, a preview that never answers 200, and a preview that exits each fail with the preview torn down; a stranger's listener is refused; hooks never run; abbreviated, unknown, and non-commit ids are refused.

## 2. Sandbox for project commands

### Requirements and candidates

A preview must bind its loopback port and accept the browser, with no other network; setup needs outbound network for dependency install; both must keep the step 1 deny-list, the git write-deny, the keychain, and the factory's environment out of reach.
Each candidate ran the same probe (`curl` egress, a keychain lookup, a Bun server on the port, a fetch of it from outside and from inside) with the step 1 deny-list:

| Candidate | Server binds and browser reaches it | No outbound in the preview | No reach to other local services | Keychain item hidden | Notes |
|---|---|---|---|---|---|
| `codex sandbox -P factory` with the step 1 `-c` flags | no: `EADDRINUSE` (bind denied) with network restricted | yes | yes | yes (rc 44) | Network is all or nothing in the profile |
| same, with `network={enabled=true}` (or `mode="limited"`, `allow_local_binding=true`) | yes | no: `NET-OPEN` | no: `LOCAL-LATERAL-OPEN` | yes | `mode="limited"` needs Codex's in-process proxy, absent in `codex sandbox` |
| Claude's sandbox runtime (`@anthropic-ai/sandbox-runtime` 0.0.83, `srt`) with `allowedDomains: []`, `allowLocalBinding: true` | yes | yes (proxy) | no: `LOCAL-LATERAL-OPEN` | yes | A new npm dependency (Node, `node-forge`, a SOCKS server); injects about 20 proxy variables and rewrites `TMPDIR` to `/tmp/claude` |
| `/usr/bin/sandbox-exec` with a factory profile | yes | yes | yes | yes (rc 44) | No dependency; full control of every rule |

The lateral check started an "owner service" on `127.0.0.1:4198` outside any sandbox and fetched it from inside; `srt`'s `allowLocalBinding` is documented as "bind and accept on any local port, and connect to localhost on any port" on macOS, which the probe confirmed.
Keychain baseline: `security find-generic-password -s software-factory.github-app.pem` returns rc 0 outside any sandbox, so rc 44 inside means hidden, not absent (the ambiguity step 1 hit does not apply when the item is known to exist).

Decision: `/usr/bin/sandbox-exec` with the profile from `sandboxProfile`.
`sandbox-exec` is marked deprecated in its man page, but it is what Codex, Claude Code's runtime, and Chrome use underneath on macOS, and it is present on macOS 26.6.2; if Apple removes it, all three candidates break together.

### The profile

- `(deny default)`, then process exec and fork, signals and process info within the sandbox, `sysctl-read`, POSIX semaphores, and one mach service, `com.apple.system.opendirectoryd.libinfo` (user lookup).
  No other mach service, so the keychain daemon is unreachable and `security` fails.
- Reads everywhere except the step 1 deny-list (`effectiveDenyRead`: state root, harness homes, credential stores, the owner's harness homes, Orca's app data), each also by realpath.
- Writes only in the worktree and the private home, plus `/dev/null`, `/dev/zero`, `/dev/dtracehelper`, and `/dev/fd`; the worktree's git dirs from step 1's `gitWriteProtectedPaths` are denied after that.
- Network by phase:
  - setup: outbound IP connections and the system DNS socket `/private/var/run/mDNSResponder` only, with loopback denied;
  - preview: `network-bind` and `network-inbound` on `localhost:<port>` only, no outbound at all;
  - none: nothing.
- Every path travels as a `-D` parameter and the profile only refers to `(param "...")`, so no path is ever spliced into the profile text and none needs escaping; a test creates a writable root named `we"ird) (allow default` and shows it neither appears in the profile nor breaks it.
- The environment is built from scratch (`projectEnv`): `HOME`, `TMPDIR`, `PATH` (the verified tool dirs, here `~/.bun/bin`, then the system dirs, checked like step 1's agent PATH), `USER`, `LOGNAME`, `LANG`, `PORT` for the preview, plus the project's declared plain variables, which cannot override any of those.

Two gaps were found and closed while testing:

1. A bare `(allow network-outbound)` also allows connecting to every unix socket, such as ssh-agent, Docker, or Orca's runtime socket; from inside, `Bun.connect({ unix })` to a test socket printed `unix:OPEN`.
   Restricted to `(remote ip)` plus the DNS socket it printed `unix:BLOCKED ENOENT`, and HTTPS to the npm registry still answered 200; without the DNS socket, resolution failed (`ip:000`).
2. `(remote ip)` includes loopback, so an install script could reach the owner's local servers (`LOOPBACK-SELF 200` in the first spike run); `(deny network-outbound (remote ip "localhost:*"))` closes it for `127.0.0.1`, `localhost`, and `[::1]`, while the registry still answers.

A service bound to `0.0.0.0` stays reachable from setup through the machine's LAN address, as it is from any LAN host; setup is the only phase with network.

### Probes inside the preview's sandbox

Run with `Preview.run` beside the live preview, with `FACTORY_CANARY` set in the factory's environment, and with the canary probe's `HOME` pointed at the account home (the probe resolves its targets from `$HOME`, and the preview's own `HOME` is the empty private home, which made the first attempt report every target MISSING and `RESULT INCONCLUSIVE`):

```
--- canary probe, preview profile: exit 0, quarantine []
CONTROL-OK
DENIED ~/.software-factory/canary.txt
DENIED ~/.software-factory/github-app.json
... (all 23 targets DENIED, the same list as spike 01)
INDIRECT-HIDDEN
ENV-HIDDEN
ENV-NAMES HOME LANG LC_ALL LOGNAME PATH PORT PWD SHLVL TMPDIR USER _
NET-BLOCKED
RESULT PASS
--- canary probe, setup profile: exit 0, quarantine []
DENIED-COUNT 23
INDIRECT-HIDDEN
ENV-HIDDEN
NET-OPEN
RESULT LEAK          (expected: setup is the phase with network; the files and env stay hidden)
--- git-write probe, preview profile: exit 0, quarantine []
WRITE-DENIED ~/orca/projects/factory-pilot/.git/hooks/factory-git-write-marker
WRITE-DENIED ~/orca/projects/factory-pilot/.git/objects/factory-git-write-marker
WRITE-DENIED ~/orca/projects/factory-pilot/.git/factory-git-write-marker
WRITE-DENIED ~/orca/projects/factory-pilot/.git/config (open for append)
WRITE-DENIED ~/orca/projects/factory-pilot/.git/worktrees/preview-7384f8b5/factory-git-write-marker
WRITE-DENIED ~/orca/projects/factory-pilot/.git/worktrees/preview-7384f8b5/HEAD (open for append)
WRITE-DENIED <tmp>/factory-previews-wlHecR/preview-7384f8b5/.git (open for append)
WORKTREE-EDIT-OK
RESULT PASS
--- keychain, preview profile: exit 0, quarantine []
KEYCHAIN-RC=44
--- network, preview profile (serve): exit 0, quarantine []
HTTPS 000
LOOPBACK-SELF 000
--- network, setup profile (outbound): exit 0, quarantine []
HTTPS 200
LOOPBACK-SELF 000
### preview still serving after the probes: 200
```

`LOOPBACK-SELF` is the preview's own `/health`: the preview cannot even call itself, so an app that renders by fetching its own API server-side will fail under this profile; such a project would need a declared extra loopback port, decided when one exists.
The server's own `bun install` with the preview profile fails with `error: ConnectionRefused downloading tarball escape-html@1.0.3`, while the setup profile installs it, which is the phase split the design asks for.

Tests (`test/verify-sandbox.test.ts`, real `sandbox-exec`): denied files are unreadable directly and by `grep -r`; writes land only in the writable roots, never the git dir, `/tmp`, or elsewhere; `security list-keychains` fails while user lookup works; the preview binds and serves its port, cannot bind another, and cannot reach a loopback service; setup cannot reach loopback or a unix socket but can reach the DNS socket, which the preview cannot; the environment carries nothing of the factory's.

## 3. Orca browser with a clean profile

`createVerificationProfile` runs `orca tab profile create --label factory-verify-<id> --scope isolated` and accepts only an isolated profile with no import source; `deleteVerificationProfile` refuses `default`.
`withVerificationTab` opens every capture tab with `--profile <that id>` on `about:blank`, then checks `orca tab profile show --page` returns the same id before anything loads, so a capture can never run in the owner's Default profile, which was imported from the owner's Chromium profile (`source.profileName` set).

Proof that the owner's GitHub session is absent, without reading the owner's cookies: the clean tab loads the private PR, then `orca cookie get --url https://github.com` reports names only (values never leave Orca's answer except `logged_in`):

```
clean profile on the private PR: {"title":"Page not found · GitHub · GitHub","profileId":"e0096ef1-..."}
github cookies: {"cookieNames":["_gh_sess","_octo","cpu_bucket","logged_in","preferred_color_mode","tz"],"loggedIn":"no","signedIn":false}
```

The positive control is section 5: the same PR in the Default profile renders with the owner signed in.
The cookie check reads the page's own partition, shown by GitHub's fresh anonymous cookies appearing there after the load.

Orca findings that shaped the module:

- A tab created on a URL misses the console and network entries of its first load: capture attaches on the tab's first command.
  `orca tab create --url http://127.0.0.1:4199/?error=1` then `console` gave 0 entries; `about:blank`, a `console` call, then `goto` gave the planted error and both requests.
- `orca tab profile delete` reports `deleted: true` but leaves the partition on disk: `~/Library/Application Support/orca/Partitions/orca-browser-session-<id>` (about 2 MB each) is still there after an Orca restart.
  Every verification profile this spike deleted left one (the final run's `orca-browser-session-e0096ef1-...` is 2.5 MB); they hold only fixture pages and anonymous GitHub cookies.
  The factory does not delete inside Orca's app data; this is reported for Orca instead.
- `orca browser identity set --mode clean|native` exists but is a global Orca setting, so it was not touched.

## 4. Evidence capture

`captureEvidence` (`src/verify/browser.ts`), per capture: a new tab as above, `wait --load load`, `viewport --width --height --scale [--mobile]`, the stabilize script, `screenshot --format png` copied into the evidence dir (exclusive create, PNG signature checked, SHA-256 recorded), `console`, `network`, `exec --command read` for page text, `tab show` for the final URL, then the tab closes whatever happened.
Viewports are fixed: desktop 1440x900 at scale 1, mobile 390x844 at scale 3 with touch emulation; screenshots are in CSS pixels (390x844 for mobile).
The record type is `EvidenceRecord` in `src/verify/evidence.ts`: AC id (`AC-1` form, null until step 5 binds criteria), name, commit SHA, URL, viewport, screenshot path and hash, console errors (level `error`), failed requests (status 400 or more, or no response), page text, truncation flags, profile id, what stabilization saw, and the capture time.

Run on the fixture with `?error=1` (one planted console error and one 404):

```
capture before-a-desktop: sha256 a52ee39fcc418e15, console ["fixture: planted console error"], failed ["GET /missing.json 404"], banner text false, stabilized {"width":1440,"height":900,"fonts":true,"frames":false,"visibility":"visible"}
capture before-a-mobile:  sha256 320c803e44f139ac, console [...same...], banner text false
capture before-b-desktop: sha256 a52ee39fcc418e15
capture before-b-mobile:  sha256 320c803e44f139ac
stability desktop: IDENTICAL
stability mobile: IDENTICAL
capture after-desktop: sha256 2617112a6f2713b8, banner text true
capture after-mobile:  sha256 3104a530b809b8ac, banner text true
before/after desktop: DIFFERENT
before/after mobile: DIFFERENT
```

The acceptance check here is page text: `Verified change: the banner is new.` is absent on the before commit and present on the after commit.

### Nondeterminism

- Animation: the fixture fades its card in over 600 ms.
  Without stabilization, two captures of the same commit gave different mobile screenshots (`bd985893...` and `3104a530...`); the first caught the banner and text mid-fade at partial opacity.
  The stabilize script injects `animation: none; transition: none` for every element, finishes running animations, hides the caret, and turns off smooth scrolling; with it, both runs were byte-identical at both viewports.
- Fonts: the script waits for `document.fonts.ready`, bounded to 5 seconds; if fonts are still loading the capture fails rather than produce an unrepeatable screenshot.
  The fixture uses system fonts, so this was not exercised by a real web font.
- Frames: `requestAnimationFrame` never fired in these tabs (`frames: false` in every capture, even with `visibility: visible`), and an unbounded two-frame wait hung `orca eval` until its 15-second timeout in an earlier version; the frame wait is now bounded to 500 ms and only recorded.
  Screenshots were still identical, because Orca's screenshot forces a paint.
- Viewport: Orca resets emulation on every navigation, including a page's own `location.reload()`, so the page loads at the pane's size and is resized afterwards.
  CSS media queries follow the resize; script that measured the window at load does not.
  The stabilize script returns the layout viewport and the capture fails unless it matches.
- Not covered: time-dependent content, randomness, and network-dependent content; the fixture has none, and masking them belongs to step 5's rubric.
- Orca's console capture does not include Chromium's own "Failed to load resource" messages; failed requests come from the network list instead, where a refused connection appears with no status.

## 5. Evidence upload through the GitHub App

`src/github/app.ts` loads `~/.software-factory/github-app.json` (owner-only, not group or world writable, numeric `id` and `installation_id`), reads the key with `/usr/bin/security find-generic-password -s software-factory.github-app.pem -a <app id> -w` (fixed env, bounded, the secret only on a pipe), decodes the base64 PEM into a `KeyObject`, signs an RS256 JWT (`iat` 60 seconds back, `exp` 9 minutes ahead), and mints an installation token limited to named repositories and a permission subset, refusing one that lacks a requested permission.
The token is an `InstallationToken` whose string, JSON, template, and `inspect` forms all print `[redacted installation token]`; errors carry the method, path, status, and GitHub's `message` only, never a header or a response body.
Each operation mints its own narrow token: `contents: read` to fetch commits, `contents: write` plus `pull_requests: write` to publish the fixture, and `contents`, `pull_requests`, and `issues` write to publish evidence:

```
### publishing with a token scoped to ["factory-pilot"] {"issues":"write","contents":"write","metadata":"read","pull_requests":"write"}, printed as [redacted installation token]
```

### Options for a private repository

GitHub has no API to attach an image to a comment, so four ways of linking one screenshot were posted in one comment on PR #1 and checked in the owner's Default profile (read-only: open, read image load state, screenshot, close):

| Link | Renders for the owner | Notes |
|---|---|---|
| A: `github.com/<o>/<r>/blob/<sha>/<path>?raw=true` | yes (`naturalWidth` 1440) | |
| B: `github.com/<o>/<r>/raw/<sha>/<path>` | yes (1440) | Equivalent to A |
| C: `raw.githubusercontent.com/<o>/<r>/<sha>/<path>` | no (`naturalWidth` 0, broken image) | Needs a token in the URL for a private repo |
| D: release asset `github.com/<o>/<r>/releases/download/<tag>/<file>` | yes (1440) | Needs a release and a tag per evidence set |

Upload-variant comment: https://github.com/Scylla23/factory-pilot/pull/1#issuecomment-7002050195.
The temporary release and its tag were deleted after the check, so its D image no longer loads.
Comment attachments uploaded through the web UI (`user-attachments`) need a user session, which an App does not have.

Decision: A, committed to a dedicated orphan branch.
`commitFiles` (`src/github/commit.ts`) creates blobs, a tree, and a commit through the Git Data API, so no git credentials touch disk, and moves the ref only by fast-forward (`force: false`), rebuilding once on the new head if another writer moved it.
`publishEvidence` (`src/github/evidence.ts`) commits the screenshots and an `evidence.json` manifest under `pr-<n>/<attempt id>/` on `factory-evidence`, then comments with the images linked at that exact commit, so later evidence never changes what an older comment shows.
Release assets (D) also render but cost a release and a tag per evidence set, notify watchers, and clutter the project's releases.
The evidence branch is never merged and is not part of any PR diff; it grows with every verification, which step 9 or later can prune by age once PRs close.

### The evidence comment

The body starts with a hidden marker, `<!-- factory:evidence pr=<n> head=<sha> attempt=<id> evidence=<sha> -->`, so it never begins with `/approve`.
Every page-derived string (console text, URLs, failed requests, page text) appears only inside a fenced code block whose fence is longer than any backtick run in it, so a page cannot close it and inject mentions, links, images, markers, or approval text; each block is capped at 2,000 characters and the comment at 65,000.
Group titles and record names are validated plain words.

Published by the spike run:

```
### published {"evidenceCommit":"9032be6827b7291808321c096e504886d3398abf","commentId":7002704758,"commentUrl":"https://github.com/Scylla23/factory-pilot/pull/1#issuecomment-7002704758","imageUrls":[6 URLs]}
```

Rendering in the owner's normal profile is in [section 7](#7-final-run).

Tests (`test/github.test.ts`, fake fetch and a generated RSA key): the JWT verifies with the public key and has the right claims; the keychain is asked for the right service and account and a bad secret is never echoed; a token lacking a permission is refused; every printed form of a token is redacted; errors never include the token or a body; orphan creation, fast-forward with one rebuild, and giving up after one; path and branch validation before any call; the comment's marker, image URLs, and fences against hostile page text; the publish sequence; and draft PR reuse.

## 6. Fixture app

`Scylla23/factory-pilot` branch `spike/verify-fixture`, published through the App by `scripts/spike-fixture.ts` with the Git Data API:

- `683a16be` "feat: add the spike fixture app": `server.ts` (one page, `/health`, `?error=1` logs a console error and requests a missing file), `package.json` with one dependency (`escape-html` 1.0.3, so setup needs the network), `bun.lock`, and a README.
- `4a5de054` "feat: add a visible banner": a blue banner above the heading, the one visible change.

Both commits carry `Factory-Task: v1-step-2` and `Factory-Agent: builder` and are authored by `software-factory-9f09[bot]`.
Draft PR #1, opened by the App, holds the evidence: https://github.com/Scylla23/factory-pilot/pull/1.
No planted issues from step 3 were added.

## 7. Final run

From the worktree, after `sh scripts/canary-probe.sh --setup`:

```
FACTORY_CANARY=FACTORY-CANARY-envtest-spike02 bun scripts/spike-verify.ts 683a16be19aee1f56b76ded5b5c461614f47591f 4a5de0545bb0d9326e54b5397a3c7995e5cd8ac8 1
```

The script fetches both commits into the factory checkout with a `contents: read` token, records the keychain baseline, starts the before preview, runs the section 2 probes beside it, checks the clean profile on the private PR, captures before twice and after once at both viewports, stops both previews, publishes the evidence with a scoped token, deletes the verification profile, and removes the empty preview root.
Its output is quoted in sections 1 to 5.
It exited 0, and `grep -cE 'ghs_|github_pat_|BEGIN .*PRIVATE'` over the whole output found 0.
Every screenshot hash equals the previous full run's, so captures are stable across runs, previews, and ports, not only within one run.

Evidence comment: https://github.com/Scylla23/factory-pilot/pull/1#issuecomment-7002704758, evidence commit `9032be6827b7291808321c096e504886d3398abf` on `factory-evidence`.

Rendering for the owner, read-only in the Default profile: `orca tab create --url about:blank --profile default`, `goto` the comment, then one `eval` reading each evidence image's `naturalWidth` (screenshots are in CSS pixels, so mobile is 390 wide):

```
{"found":true,"signedIn":true,"images":[
  {"alt":"before-a-desktop","w":1440,"complete":true,"host":"github.com"},
  {"alt":"before-a-mobile","w":390,"complete":true,"host":"github.com"},
  {"alt":"after-desktop","w":1440,"complete":true,"host":"github.com"},
  {"alt":"after-mobile","w":390,"complete":true,"host":"github.com"},
  {"alt":"before-b-desktop","w":1440,"complete":true,"host":"github.com"},
  {"alt":"before-b-mobile","w":390,"complete":true,"host":"github.com"}]}
```

All six render inline; a screenshot of the comment confirmed it, and the tab was closed.
Nothing else was done in that profile.

Afterwards `canary-probe.sh --cleanup` removed the planted transcripts, and no verification profile, tab, preview directory, `sandbox-exec`, `bun server.ts`, or `sleep` process remained.
Left in place on purpose: the draft PR, `spike/verify-fixture`, `factory-evidence`, `~/orca/projects/factory-pilot` (for step 3), the run logs and evidence under `~/.software-factory/spike-02/`, and `~/.software-factory/canary.txt`.

## 8. Repair round

The review of the first run (234b291) found 5 blocking and 11 should-fix issues; all were fixed, each in its own commit with tests and a mutation check.
The owner decided four questions.

### Q50: setup egress through a revocable proxy

Setup had outbound IP access, and a detached install helper that escaped the sweeps kept it after setup ended.
Setup now runs under a profile that may connect only to a factory-run HTTP CONNECT proxy on loopback (`src/verify/proxy.ts`, Bun, no dependency).
The proxy tunnels to the project's egress allowlist on 443 only, checks a fresh credential per phase, resolves names itself and dials only public addresses, and logs every decision to the attempt's private log.
`Preview.run` accepts only `none` or `serve`, checked at run time too, so no command beside the live preview can get egress back.
The preview profile may now connect to its own port, so an app can call itself; section 2's `LOOPBACK-SELF 000` no longer holds.

Egress log of the final run's base preview setup (the probes of the next section ran in it):

```
LISTEN 127.0.0.1:63854 allow registry.npmjs.org
ALLOW registry.npmjs.org:443 via 104.16.4.34
DENY example.com:443 host not in the allowlist
ALLOW registry.npmjs.org:443 via 104.16.4.34
DENY example.com:443 host not in the allowlist
DENY registry.npmjs.org:443 missing or wrong phase credential
STOP allowed 2 denied 3
```

### Blocker 3 follow-up: held proxy ports and no sandboxed listener

The final check of 394f7aa found the revocation incomplete.
The setup profile grants a port number, and the proxy released its port when setup ended, so a surviving install helper could reach whatever unrelated listener took that port later.
The proxy is now a pool (`openEgressPool`): the factory binds 4 ports on `127.0.0.1` when it loads its config and holds them for its whole lifetime, never releasing one between phases.
Each setup phase takes a free pooled port and a fresh credential; ending the phase closes its connections and revokes the credential, and the port stays bound.
A survivor that tries again reaches the factory's port and gets `407`, with no phase live or with a later phase's different credential, and connections to a port are bounded whether or not a phase is live.

Probes of what the grant reaches (a factory listener on `127.0.0.1:P`, an unrelated one on another address at the same port):

```
stranger binds 127.0.0.1:P, plain or SO_REUSEPORT     EADDRINUSE
stranger binds 0.0.0.0:P, [::]:P, [::1]:P              bound
grant (remote ip "localhost:P"), connect [::1]:P       reaches the stranger
grant (remote ip "localhost:P"), connect LAN:P         reaches a stranger on 0.0.0.0:P
grant (remote tcp4 "localhost:P"), connect [::1]:P     refused
grant (remote tcp4 "localhost:P"), connect LAN:P       reaches a stranger on 0.0.0.0:P
grant on another port or no network, connect LAN:P     refused
```

Seatbelt accepts only `*` and `localhost` as hosts (`127.0.0.1:P` is a profile error), and its `localhost` also matches `::1`, `[::]`, and the Mac's own LAN address.
Every network rule is now IPv4 only (`tcp4`), which closes the IPv6 path.

No sandboxed process can run a relay.
Setup may listen nowhere: `(deny default)` already refused every bind, and its profile repeats the deny after the outbound rule, so no later allow can give setup a listener.
The preview may bind only its own port, over IPv4 TCP, and connect only to that same port.
Binds probed under each profile, P being the phase's port:

```
setup    tcp and udp on 127.0.0.1:P 0.0.0.0:P [::]:P [::1]:P LAN:P 127.0.0.1:P+1 0.0.0.0:0    EPERM, every one
preview  tcp 127.0.0.1:P                                                                    bound
preview  udp 127.0.0.1:P; tcp and udp on [::]:P [::1]:P 127.0.0.1:P+1 0.0.0.0:P+1 127.0.0.1:0    EPERM
preview  tcp 0.0.0.0:P, tcp LAN:P                                                           bound, answers on the LAN address
```

Seatbelt cannot tell `127.0.0.1` from `0.0.0.0` or a LAN address, so the preview could still listen on its own port beyond loopback.
The factory refuses that from its listener check: every listener on the port must be the preview's and listen on `127.0.0.1:P` only, at readiness and at every `serving()` check, and a preview that listens on `*:P` fails with `the preview listens on *:P, beyond 127.0.0.1`.
From its bind to the next check, such a listener answers on the LAN address, and it can reach nothing but its own port.

Two residuals are accepted.
First, the LAN-address path: a setup survivor can connect to the Mac's LAN address at its granted port, where only a process listening on `0.0.0.0:P` or the LAN address would answer.
No sandboxed process can listen there, so the precondition is an unsandboxed local process listening on a pooled port (or on a preview's port, which a setup grant never names) and relaying; a local accomplice outside every sandbox already defeats the whole model, and binding refuse-only sinks on every LAN address would put the factory on the network, prompt the firewall, and need re-checks as addresses change.
Second, the pool lives as long as the factory process: if the factory exits while a survivor lives, the ports are released, and that attempt was already quarantined by the cleanup rule (a survivor is found or the attempt says it cannot be sure).
Step 9's daemon will hold the pool for its lifetime.

The proof, in tests and mutation-checked: a detached `setsid` setup child survives its phase, an unrelated listener binding its port gets `EADDRINUSE`, its requests through the port get `407` after the phase, and a new phase on the same port with a new credential gets through while the old credential stays refused (`verify-preview`, `verify-proxy`); every bind above, and the IPv6 connect, as `verify-sandbox` tests.

### Q51: reads closed by default

Reads were open everywhere except the dispatch deny-list, so an install hook with network could read another project's `.env` or a credential file the list does not name.
Reads are now allowed only in the worktree, the private home, the project's own git dirs, explicit toolchain roots, and a fixed system list, with the deny-list on top as a second layer.
Bun lists each directory above its working directory and starts with an empty environment when it cannot, so the directories above a writable root may be listed (names, not contents).

Proof, from the final run, during setup with the network on (through the proxy), and again beside the preview:

- The canary probe (section 2) ran as a setup command: all 23 targets `DENIED`, `INDIRECT-HIDDEN`, `ENV-HIDDEN`, `NET-BLOCKED`, `RESULT PASS`, exit 0.
- The driver planted `API_KEY=FACTORY-CANARY-<random>` in `~/orca/projects/factory-sibling-canary-<id>/.env`, a sibling of the fixture project, readable by the factory itself.
  `scripts/sibling-probe.sh` read it directly and searched both the sibling and `~/orca/projects` for the value: `CONTROL-OK`, `DENIED <sibling>/.env`, `INDIRECT-HIDDEN`, `RESULT PASS`, exit 0, in setup and beside the preview.
  The driver removed the sibling afterwards.

### Q52: the browser cannot be held to the preview origin

Orca's only request filter is `network route <glob> [--abort]` through `orca exec`; profiles have no proxy setting (`orca tab profile create` takes a label and a scope only).
Probed with an isolated profile, a "preview" on `127.0.0.1:4291` whose page calls an "outside" server on `127.0.0.1:4292` that counts hits:

```
network route http://127.0.0.1:4292/** --abort         the page loads, the outside server gets 0 hits
network route ** --abort                               the preview itself fails: ERR_FAILED (-2) loading 'http://127.0.0.1:4291/'
  then network route http://127.0.0.1:4291/**          still ERR_FAILED: no later route exempts the preview
network route http://127.0.0.1:4291/** first, then ** --abort    still ERR_FAILED
patterns 429[2], {4292,4293}, 429[!1], 429?, and a regex      accepted, matched nothing: 3 outside hits
```

A route can block a named destination, but nothing can say "only this origin".
A partial denylist was not implemented: loading the preview at `http://localhost:<port>` and aborting `https://**`, `wss://**`, and `http://*.*/**` would block dotted hosts and IP addresses, but not `http://localhost:<other port>` or dotless names, and whether routes cover service workers, WebSockets, and prefetches was not tested.
`orca set offline` is a whole-tab switch, and `orca intercept` pauses requests for a per-request decision; neither was tried as an origin filter.

Per the owner's decision, the gap is recorded rather than faked.
Every `EvidenceRecord` carries `browserEgress: "unrestricted"`, its `origin`, and `externalOrigins` (the other origins Orca's network log saw), the PR comment says egress was unrestricted, and design.md lists it as a known gap.
Within that gap, each capture is still bound to the preview: the page must be on the preview origin after load and after the screenshot, and the preview server that passed readiness must still hold its port alone at both points.

### Q53: evidence stays local

`src/github/evidence.ts` and its orphan `factory-evidence` branch are gone.
`openEvidenceStore` (`src/verify/store.ts`) gives each attempt `<state root>/evidence/<attempt>`, created exclusively under an owner-only root; files are created exclusively, never through a symlink, mode 600, copied from a regular file only up to its size at open, at most 32 MiB each and 256 MiB per attempt.
`publishSummary` (`src/github/summary.ts`) posts one text-only comment with a token limited to `pull_requests: write`: it refuses a failed verdict before any GitHub call, re-reads the PR and refuses if its base or head moved since capture, and updates the App's own comment for the same PR and attempt instead of adding another.
Page-derived and command-derived text is redacted (URL query and fragment, token-like values, emails, the account home as `~`), capped, and fenced.
Tokens are checked against an injected clock with a 5-minute refresh margin, an expired one is never used for git or the API, and the App no longer asks for `issues: write`.
Evidence is kept until the owner removes it.
The existing `factory-evidence` branch and PR #1's image comment were left for the owner.

### Revision binding and the verdict

`scripts/spike-verify.ts` takes only a PR number, records its base and head before any capture, previews the base as before and the head as after, and every capture names its commit; the comment's marker carries `base=`, `head=`, and `capture=`.
Every observation is a check from `src/verify/checks.ts` that keeps its own status: a probe passes only on its own exit 0 (the probes exit 1 on a leak and 2 when inconclusive), with nothing left running; teardowns, git-write markers, the signed-out PR page, screenshot stability, the base and head difference, the expected change, and the planted console error are checks too.
Setup-phase probes run as setup commands, so a failing one stops the preview and fails the attempt.
`scripts/network-probe.sh` checks each phase's network and `scripts/sibling-probe.sh` the sibling `.env`; `scripts/spike-verify-pr.ts` opened PR #2, whose base `spike/verify-base` is the fixture's first commit, so before is the PR's base.

### Mobile emulation

Probed on a fresh isolated tab with a page that records its size, scale, touch points, `pointer: coarse`, and user agent at load:

```
viewport --width 390 --height 844 --scale 3 --mobile, then goto    390x844 dpr:3 touch:5 coarse:true ua-mobile:false
set device --name "iPhone 12", then goto                           390x844 dpr:3 touch:5 coarse:true ua-mobile:true
desktop viewport on a fresh tab after a device tab                 1440x900 dpr:1 touch:0 coarse:false ua-mobile:false
the same page after load, on a reused tab                          values at load as above, now 1621x979
```

Emulation set on the blank tab before `goto` applies at load, so section 4's statement that the page loads at the pane's size no longer holds.
`--mobile` alone keeps a desktop user agent, so the mobile viewport uses the `iPhone 12` preset, whose answer is checked for width, height, scale, and mobile.
Orca resets the size after load, so the capture sets emulation again after `wait --load load` and checks the layout viewport before the screenshot.
The user agent is per tab, and each capture uses a new tab.

### Bun 1.2.10 runner wedge

The intermittent hang noted under [Tests](#tests) is explained.
`Bun.spawnSync` in Bun 1.2.10 runs timers and other async continuations while it waits: a timer callback runs inside it.
Under `bun test`, a test that ends while other work waits in `Bun.spawnSync`, with an `afterEach` that awaits that work, wedges the runner for good, idle in `kevent64`; a minimal repro wedged 3 runs of 3.
Tests now settle the factory work they started inside the test body (`settlingTest` in `test/verify-helpers.ts`): the repro then finished 3 of 3, and the mutation that wedged the full suite in 3 runs of 6 wedged 0 of 8.
Every spawn and fetch in the tests is bounded, and `scripts/test-watchdog.sh` bounds a whole run from outside Bun, recording `sample`, `ps`, and `lsof` and killing the run when it overruns, and killing anything a run leaves behind.

The production side is not fixed: the factory's `ps`, `lsof`, and git calls go through `Bun.spawnSync`, so other async work can run in the middle of them.
`startPreview` handles the one interleaving found (a stop that lands while a check is being spawned), and port leases re-read a lease before reclaiming it for the same reason.
Moving those calls to async spawns, or a Bun release without the reentrancy (Bun is pinned at 1.2.10), is the owner's call.

### Final runs

From the worktree, after `sh scripts/canary-probe.sh --setup` and `bun scripts/spike-verify-pr.ts`:

```
FACTORY_CANARY=canary-<random> bun scripts/spike-verify.ts 2
### PR #2: base spike/verify-base 683a16be19aee1f56b76ded5b5c461614f47591f, head 4a5de0545bb0d9326e54b5397a3c7995e5cd8ac8
### base preview 683a16be19ae ready on http://127.0.0.1:4195 in 1613ms (spawn to 200: 268ms)
capture base-a-desktop: sha256 a52ee39fcc418e15, console errors 1, other origins []
capture base-a-mobile: sha256 320c803e44f139ac, console errors 1, other origins []
capture base-b-desktop: sha256 a52ee39fcc418e15, console errors 1, other origins []
capture base-b-mobile: sha256 320c803e44f139ac, console errors 1, other origins []
### head preview 4a5de0545bb0 ready on http://127.0.0.1:4167 in 774ms (spawn to 200: 261ms)
capture head-desktop: sha256 2617112a6f2713b8, console errors 1, other origins []
capture head-mobile: sha256 3104a530b809b8ac, console errors 1, other origins []
### sibling canary removed: true
### verdict PASS
### published {"id":7006220670,"htmlUrl":"https://github.com/Scylla23/factory-pilot/pull/2#issuecomment-7006220670","updated":false}
```

All 29 checks passed; the hashes equal the first run's.
Beside the preview, the network probe printed `REACHED the preview's own port 200`, then `BLOCKED` for another loopback port, an outside host, and a public address; with no network, all four were blocked.
In setup, `REACHED allowed host through the proxy 200`, then `BLOCKED` for a denied host through the proxy, the allowed host and a public address bypassing the proxy, and the proxy without its credential.
The git-write probe printed `WRITE-DENIED` for all seven targets and `WORKTREE-EDIT-OK`, and the keychain probe `KEYCHAIN-RC=44` against a baseline of 0 outside.

The gate, on real runs:

- With the expected change set to text the head does not add (a local edit, reverted), the run printed `verdict FAIL: change on head only (desktop), change on head only (mobile)` and `not published`, exited 1, and the PR's comment count stayed 2.
- Publishing the passed attempt's records with base and head swapped, as if the PR had moved, was refused by GitHub's answer: `PR #2 moved since capture: base 4a5de0545bb0 -> 683a16be19ae, head 683a16be19ae -> 4a5de0545bb0`, nothing posted.
- Publishing the passed attempt again returned `"updated":true` with the same comment id, and the PR still had 2 comments.

The first passing attempt (comment 7006002523) showed a fragment of the account name at the start of a log excerpt, because a log tail began mid-line where redaction could not see the home path.
Tails now start at a line boundary, and the second attempt's comment has none; the first comment is left for the owner.

Rendering for the owner, read-only in the Default profile: one tab on the comment, a screenshot, and the tab closed; the comment shows the checks and captures tables and the redacted diagnostics.
Afterwards `canary-probe.sh --cleanup` removed the planted transcripts, and no verification profile, tab, preview directory, port lease, sibling canary, or preview process remained.
Left in place on purpose: PR #2 and `spike/verify-base`, the runs' logs under `~/.software-factory/spike-02/<attempt>`, and their evidence under `~/.software-factory/evidence/<attempt>`.

### Residual risks

- Browser egress during capture is unrestricted (Q52).
- `Bun.spawnSync` reentrancy in production code (above).
- Orca keeps a deleted profile's partition on disk (section 3).
- `materializeCommit` does not check that the registered repo path is a git toplevel; a path inside another repository would materialize from that one.

## Proposed design changes

These refine [design.md](../design.md).
The repair round applied 1 and 3 to it, with reads closed by default and setup egress through the proxy; 2 is replaced by the local evidence store and the text-only comment (Q53); 4 no longer holds, since a preview may call its own port.

1. Project command sandbox.
   Add to "Build, check, review, verify": "Project setup, test, lint, typecheck, and preview commands run under a factory-written Seatbelt profile with `/usr/bin/sandbox-exec`: the dispatch deny-list, writes only in the worktree and a private home, no keychain, and network by phase (setup: outbound IP except loopback; preview: its own loopback port only; checks: none)."
2. Evidence upload.
   Add to "Evidence table": "Screenshots are committed to the project's orphan `factory-evidence` branch and linked from the PR at that commit (`blob/<sha>/<path>?raw=true`), which renders inline for readers with access to a private repository."
3. Preview checkout.
   "Verification starts the preview from the reviewed commit" needs a factory-controlled checkout per project, outside agent-writable roots, filled by token-authenticated fetches of exact commits; the project's registered repo path should be that checkout, not a working copy the owner edits.
4. Preview limits a project must know.
   A preview cannot make any outbound connection, including to itself; a project that needs one declares it, decided when one exists.
5. Clean browser profile.
   "A clean browser profile" means a fresh isolated Orca profile per verification, deleted afterwards; Orca keeps the deleted profile's partition on disk, to be raised with Orca.

## Module

- `src/verify/sandbox.ts`: the Seatbelt profile, `sandboxArgv`, and the project environment.
- `src/verify/materialize.ts`: detached worktree at an exact commit, hooks off, and its removal.
- `src/verify/port.ts`: task port choice, port probe, and `lsof` listeners.
- `src/verify/preview.ts`: `loadVerifyConfig`, `startPreview` (setup, preview, readiness, listener ownership, teardown), `Preview.run`.
- `src/verify/browser.ts`: verification profile, tab lifecycle, stabilization, `captureEvidence`, and the GitHub session check.
- `src/verify/evidence.ts`: `EvidenceRecord`, viewports, and the console and network parsers.
- `src/github/app.ts`: metadata, keychain key, JWT, scoped installation tokens.
- `src/github/api.ts`: one repository's client.
- `src/github/commit.ts`: Git Data API commits with fast-forward only.
- `src/github/pulls.ts`: draft PR, comments.
- `src/github/fetch.ts`: token-authenticated fetch of exact commits.
- `src/verify/proxy.ts`: the setup phase's egress proxy (repair round).
- `src/verify/store.ts`: the local evidence store (repair round).
- `src/verify/verdict.ts` and `src/verify/checks.ts`: checks and the verdict that gates publication (repair round).
- `src/github/summary.ts`: the redacted text-only PR comment (repair round; it replaced `src/github/evidence.ts`).
- Reused from step 1: `spawnAgentProcess`, `superviseRun`, `terminateTree`, `sweepWorktree`, `Tracker`, `snapshot`, `runGit`, `gitWriteProtectedPaths`, `effectiveDenyRead`, `trustedAgentPath`, `assertSafeDir`, `orcaJson`.
- Changed in step 1 code: `sweepWorktree` takes `spare`; `assessCleanup` folds supervision and sweep into one verdict for `runAgent` and previews alike; `runGit` takes a timeout and names the subcommand after leading `-c` options.

## Tests

`bun test`: 204 pass, 0 fail across 12 files; `bun run typecheck` passes.
New files: `verify-sandbox` (10, real `sandbox-exec`), `verify-port` (3), `verify-materialize` (4, real git), `verify-preview` (10, real git, sandbox, and Bun servers), `verify-browser` (13, a fake `orca`), and `github` (17, a fake `fetch` and a generated RSA key).
The preview and sandbox files passed 17 runs in a row.

Mutation check: 34 single-rule mutations, each applied alone, its test file run, and the source restored.
They cover every sandbox rule, hooks off, the agent-root refusal, the sweep's spare, the run and teardown sweeps, setup failure, listener ownership, readiness on exit, the tab's profile binding, capture attach before load, tab close on failure, the viewport check, the session cookie, 404 as a failure, token redaction, error bodies, the permission check, key echo, forced refs, the 422 rebuild, path traversal, fence length, and text outside the fence.
All 34 are killed, each by the test meant to catch it.
The first pass found four gaps, all in tests:

- The DNS socket rule survived: the test resolved `localhost` with `dscacheutil`, which asks opendirectoryd, not the DNS socket.
  It now connects to `/private/var/run/mDNSResponder`, open in setup and closed in the preview.
- Teardown's sweep was only caught through a stray process another mutation had leaked.
  A new test has the preview detach a process from its group and shows teardown finds and kills it and keeps the worktree.
- Leftover checks used a global `pgrep`, so any stray from another run failed them.
  They now check the pids the sweep reported, and tests that expect a failed start stop a preview that starts anyway, so a mutation cannot leak a server.
- The fence mutation was equivalent (it moved console text within the fence); its replacement puts the text outside and is killed.

Not resolved: twice, the preview test file hung for minutes under the "sweep kills the spared preview" mutation, and Bun's 5-second test timeout did not fire.
Eighteen later runs of that mutation and 17 unmutated runs did not hang, and every synchronous child call in `src/` is bounded.
If it recurs, `sample <bun pid>` shows where it waits.
That hang is the Bun 1.2.10 runner wedge explained in section 8.

Repair round: `bun test` runs 275 tests across 16 files, 0 fail, 0 skip, and `bun run typecheck` passes.
New files: `verify-proxy`, `verify-store`, `verify-checks`, and `watchdog`.
Mutation check: 161 single-change mutants over the repair round's code, tests, and scripts, each killed by the test meant to catch it; one was killed by a Bun crash and one by a hang, which the watchdog now bounds.
The first 20-run attempt hung in its 13th run: a step 1 test stopped a run with a 300 ms timeout and then waited for a pid the fake CLI writes only after starting its child, so a slow shell start left a poll running past the test timeout into later tests; the watchdog stopped the run at 900 seconds with its stacks recorded.
The test now stops the run through its abort signal once the pid exists (a fake delayed by 0.5 seconds reproduces the old failure and passes with the fix).
After that fix, 20 consecutive full runs under `scripts/test-watchdog.sh` each passed 275 of 275 tests in 72 to 86 seconds, and `bun run typecheck` passed.
