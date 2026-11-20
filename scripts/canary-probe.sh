#!/bin/sh
# Credential canary probe for agent dispatch.
#
#   canary-probe.sh --targets   list credential target paths for a disposable fixture
#   canary-probe.sh --setup     plant indirect-read canaries (outside any sandbox; idempotent)
#   canary-probe.sh --baseline  outside any sandbox: prove every target exists and is readable, so a sandbox DENIED means something
#   canary-probe.sh             inside the agent sandbox: probe, print one status line per check
#   canary-probe.sh --cleanup   remove the planted transcript canaries
#
# Prints only status words and paths, never file contents.
# Exit 0: pass. Exit 1: a leak. Exit 2: inconclusive (no leak seen, but a check could not prove denial).
# A leak wins over inconclusive.
#
# The macOS keychain is probed only as the login.keychain-db file.
# `security find-generic-password` is not used: its rc 44 means "not found" both when the item is absent
# and when the sandbox hides it, so it cannot tell denial from absence.
set -u
export LC_ALL=C

H=$HOME
PLANTED_CLAUDE="$H/.claude/projects/-factory-canary/canary.jsonl"
PLANTED_CODEX="$H/.codex/sessions/factory-canary/canary.jsonl"
CANARY_RE='FACTORY-CANARY-[0-9a-f]{32}'

# Files that exist on the owner's machine (checked by --baseline) and must be unreadable to an agent.
TARGETS="$H/.software-factory/canary.txt
$H/.software-factory/github-app.json
$H/.software-factory/codex-home/auth.json
$H/.software-factory/claude-home/.claude.json
$H/.ssh/known_hosts
$H/.ssh/config
$H/.config/gh/hosts.yml
$H/.codex/auth.json
$H/.codex/history.jsonl
$H/.codex/state_5.sqlite
$H/.codex/config.toml
$H/.codex/AGENTS.md
$H/.claude/history.jsonl
$H/.claude/settings.json
$H/.claude/CLAUDE.md
$H/.claude.json
$H/.agents/.skill-lock.json
$H/Library/Keychains/login.keychain-db
$H/Library/Application Support/orca/orca-runtime.json
$H/.docker/config.json
$H/.npmrc
$PLANTED_CLAUDE
$PLANTED_CODEX"

# Denied trees an agent might grep through; a canary found under any of them is an indirect leak.
INDIRECT_ROOTS="$H/.software-factory
$H/.claude
$H/.codex"

leak=0
inconclusive=0

token() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }

# READABLE (cat succeeded), DENIED (EPERM or EACCES), MISSING (ENOENT), or UNKNOWN.
classify() {
  err=$(cat -- "$1" 2>&1 >/dev/null) && { echo READABLE; return; }
  case $err in
    *"Operation not permitted"* | *"Permission denied"*) echo DENIED ;;
    *"No such file or directory"*) echo MISSING ;;
    *) echo UNKNOWN ;;
  esac
}

# The files matching the canary pattern under the given roots, one per line; errors (denials) are ignored.
canary_matches() {
  grep -rIlE "$CANARY_RE" "$@" 2>/dev/null
}

plant() {
  [ -s "$1" ] && return 0
  mkdir -p "$(dirname -- "$1")" && chmod 700 "$(dirname -- "$1")" &&
    (umask 077 && printf '{"type":"user","message":{"content":"%s"}}\n' "FACTORY-CANARY-$(token)" >"$1")
}

# The offline proof uses Git's receive-pack handshake with its disposable loopback repository.
# A dry run changes no refs. Only an explicit sandbox denial counts as a blocked push.
network_probe() {
  if [ -z "${FACTORY_CANARY_GIT_PORT:-}" ]; then
    curl -sS -m 10 -o /dev/null https://example.com 2>/dev/null && echo OPEN || echo BLOCKED
    return
  fi
  case $FACTORY_CANARY_GIT_PORT in *[!0-9]*) echo UNKNOWN; return ;; esac
  remote="git://127.0.0.1:$FACTORY_CANARY_GIT_PORT/receiver.git"
  if error=$(git -c credential.helper= -c core.hooksPath=/dev/null push --dry-run "$remote" HEAD:refs/heads/probe 2>&1); then
    echo OPEN
  else
    case $error in
      *"Operation not permitted"*|*"Permission denied"*) echo BLOCKED ;;
      *) echo UNKNOWN ;;
    esac
  fi
}

case ${1:-} in
--targets)
  printf '%s\n' "$TARGETS"
  exit 0
  ;;
--setup)
  [ -d "$H/.software-factory" ] || { echo "SETUP-FAILED $H/.software-factory missing"; exit 2; }
  if ! grep -qE "$CANARY_RE" "$H/.software-factory/canary.txt" 2>/dev/null; then
    (umask 077 && echo "FACTORY-CANARY-$(token)" >"$H/.software-factory/canary.txt") || exit 2
  fi
  chmod 600 "$H/.software-factory/canary.txt" || exit 2
  plant "$PLANTED_CLAUDE" && plant "$PLANTED_CODEX" || { echo "SETUP-FAILED"; exit 2; }
  echo "SETUP-OK"
  exit 0
  ;;
--cleanup)
  rm -f -- "$PLANTED_CLAUDE" "$PLANTED_CODEX"
  rmdir -- "$(dirname -- "$PLANTED_CLAUDE")" "$(dirname -- "$PLANTED_CODEX")" 2>/dev/null
  echo "CLEANUP-OK"
  exit 0
  ;;
--baseline)
  bad=0
  status=$(printf '%s\n' "$TARGETS" | while IFS= read -r f; do echo "$(classify "$f") $f"; done)
  printf '%s\n' "$status"
  printf '%s\n' "$status" | grep -qv '^READABLE ' && bad=1
  # Only the canaries' own dirs: the full denied trees can hold gigabytes of history.
  found=$(canary_matches "$H/.software-factory/canary.txt" "$(dirname -- "$PLANTED_CLAUDE")" "$(dirname -- "$PLANTED_CODEX")" | wc -l | tr -d ' ')
  echo "INDIRECT-CANARIES-FOUND $found"
  [ "$found" -eq 3 ] || bad=1
  if [ "$(network_probe)" = OPEN ]; then echo "NET-OPEN"; else echo "NET-UNAVAILABLE"; bad=1; fi
  [ $bad -eq 0 ] && { echo "BASELINE-OK"; exit 0; }
  echo "BASELINE-INCOMPLETE"
  exit 2
  ;;
"") ;;
*)
  echo "usage: $0 [--targets|--setup|--baseline|--cleanup]" >&2
  exit 2
  ;;
esac

# Positive controls: the sandbox must still allow reading and grepping permitted files,
# or every DENIED below could be a broken probe rather than a working policy.
control_dir=$(mktemp -d "${TMPDIR:-/tmp}/canary-control.XXXXXX" 2>/dev/null) || control_dir=""
if [ -n "$control_dir" ] && echo "FACTORY-CANARY-$(token)" >"$control_dir/control.jsonl" &&
  [ "$(classify "$control_dir/control.jsonl")" = READABLE ] && [ "$(classify "$0")" = READABLE ] &&
  [ -n "$(canary_matches "$control_dir")" ]; then
  echo "CONTROL-OK"
else
  echo "CONTROL-FAILED"
  inconclusive=1
fi
[ -n "$control_dir" ] && rm -rf -- "$control_dir"

# Direct reads.
status=$(printf '%s\n' "$TARGETS" | while IFS= read -r f; do echo "$(classify "$f") $f"; done)
printf '%s\n' "$status"
printf '%s\n' "$status" | grep -q '^READABLE ' && leak=1
printf '%s\n' "$status" | grep -qE '^(MISSING|UNKNOWN) ' && inconclusive=1

# Indirect reads: a recursive search must not surface a planted canary.
hits=$(printf '%s\n' "$INDIRECT_ROOTS" | while IFS= read -r d; do canary_matches "$d"; done)
if [ -n "$hits" ]; then
  printf '%s\n' "$hits" | sed 's/^/INDIRECT-LEAK /'
  leak=1
else
  echo "INDIRECT-HIDDEN"
fi

# Environment: the dispatcher's FACTORY_CANARY must not reach the agent.
if env | grep -q '^FACTORY_CANARY='; then echo "ENV-LEAK FACTORY_CANARY"; leak=1; else echo "ENV-HIDDEN"; fi
echo "ENV-NAMES $(env | cut -d= -f1 | sort | tr '\n' ' ')"

# Network: egress must fail.
if ! command -v curl >/dev/null 2>&1; then
  echo "NET-UNKNOWN no curl"
  inconclusive=1
else
  case $(network_probe) in
    OPEN) echo "NET-OPEN"; leak=1 ;;
    BLOCKED) echo "NET-BLOCKED" ;;
    *) echo "NET-UNKNOWN"; inconclusive=1 ;;
  esac
fi

if [ $leak -ne 0 ]; then echo "RESULT LEAK"; exit 1; fi
if [ $inconclusive -ne 0 ]; then echo "RESULT INCONCLUSIVE"; exit 2; fi
echo "RESULT PASS"
exit 0
