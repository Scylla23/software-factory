#!/bin/sh
# Runs `bun test` with a wall-clock bound enforced from outside Bun, so a wedged runner (one whose own test timeouts
# cannot fire) is caught, its state recorded, and everything it started stopped.
#
#   scripts/test-watchdog.sh [bun test args...]
#
#   WATCHDOG_SECONDS  wall-clock bound for the whole run (default 900)
#   WATCHDOG_OUT      where evidence goes (default test/.state/watchdog)
#
# The run gets its own test state directory (FACTORY_TEST_STATE), so the watchdog can tell exactly which processes the
# run left behind: any process whose working directory is inside it once `bun test` is gone.
#
# Exit status: bun's own; 124 when the bound was hit; 125 when the run left processes behind (they are killed).
# On 124 or 125 the evidence directory holds `sample` stacks of the runner (on overrun), the process table, and the
# leftovers' working directories.
set -u
root=$(cd "$(dirname "$0")/.." && pwd -P) || exit 2
limit=${WATCHDOG_SECONDS:-900}
out=${WATCHDOG_OUT:-$root/test/.state/watchdog}
case $limit in '' | *[!0-9]*) echo "watchdog: WATCHDOG_SECONDS must be a whole number" >&2; exit 2 ;; esac
/bin/mkdir -p "$out" "$root/test/.state" || exit 2
state=$(/usr/bin/mktemp -d "$root/test/.state/wd-XXXXXX") || exit 2

# Pids of processes whose working directory is inside the run's state directory.
leftovers() {
  /usr/sbin/lsof -w -a -u "$(/usr/bin/id -u)" -d cwd -F pn 2>/dev/null | /usr/bin/awk -v dir="$state/" '
    /^p/ { pid = substr($0, 2) }
    /^n/ { if (index(substr($0, 2) "/", dir) == 1) print pid }'
}

record() {
  /bin/mkdir -p "$1"
  /bin/ps -axo pid,ppid,pgid,stat,lstart,command > "$1/ps.txt" 2>&1
  for p in $(leftovers); do
    /bin/ps -o pid,ppid,pgid,stat,lstart,command -p "$p" 2>/dev/null | /usr/bin/tail -n +2
  done > "$1/leftovers.txt"
}

stop_leftovers() {
  for p in $(leftovers); do /bin/kill -KILL "$p" 2>/dev/null; done
}

cd "$root" || exit 2
FACTORY_TEST_STATE=$state bun test "$@" &
pid=$!
start=$(/bin/date +%s)
while /bin/kill -0 "$pid" 2>/dev/null; do
  if [ $(($(/bin/date +%s) - start)) -ge "$limit" ]; then
    ev="$out/$(/bin/date -u +%Y%m%dT%H%M%SZ)-overrun-$pid"
    /bin/mkdir -p "$ev"
    /usr/bin/sample "$pid" 3 -file "$ev/sample.txt" > /dev/null 2>&1
    /usr/sbin/lsof -w -p "$pid" > "$ev/lsof.txt" 2>&1
    record "$ev"
    /bin/kill -KILL "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    stop_leftovers
    /bin/rm -rf "$state"
    echo "watchdog: bun test (pid $pid) passed ${limit}s; stacks and process state in $ev" >&2
    exit 124
  fi
  /bin/sleep 1
done
wait "$pid"
rc=$?
if [ -n "$(leftovers)" ]; then
  ev="$out/$(/bin/date -u +%Y%m%dT%H%M%SZ)-leftovers-$pid"
  record "$ev"
  stop_leftovers
  /bin/rm -rf "$state"
  echo "watchdog: bun test left processes running in $state; recorded in $ev and killed" >&2
  exit 125
fi
/bin/rm -rf "$state"
exit "$rc"
