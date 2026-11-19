#!/bin/sh
# Checks, from inside an agent sandbox in a linked worktree, that the shared git dirs are not writable while the
# worktree's own files are. Each attempt is inert: an empty marker file named factory-git-write-marker, or an
# append-mode open that writes nothing. Prints one status line per target and a RESULT; exit 0 pass, 1 leak,
# 2 inconclusive. The caller removes any marker that appears and counts it as a failure.
# Usage: sh git-write-probe.sh   (run in the worktree)
export LC_ALL=C
MARKER=factory-git-write-marker
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
admin=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null)
if [ -z "$common" ] || [ -z "$admin" ] || [ "$common" = "$admin" ]; then
  echo "NOT-A-LINKED-WORKTREE common=$common admin=$admin"
  echo "RESULT INCONCLUSIVE"
  exit 2
fi
leak=0
unknown=0

classify() { # $1 label, $2 error text, $3 rc
  if [ "$3" = 0 ]; then
    echo "WRITE-ALLOWED $1"
    leak=1
  else
    case "$2" in
      *"Operation not permitted"*|*"Permission denied"*|*"Read-only file system"*) echo "WRITE-DENIED $1" ;;
      *) echo "WRITE-UNKNOWN $1: $2"; unknown=1 ;;
    esac
  fi
}

create() { # create an empty marker in dir $1
  err=$( { : > "$1/$MARKER"; } 2>&1 ); rc=$?
  classify "$1/$MARKER" "$err" "$rc"
}

append_open() { # open file $1 for append and write nothing
  err=$( { exec 3>>"$1"; } 2>&1 ); rc=$?
  classify "$1 (open for append)" "$err" "$rc"
}

create "$common/hooks"
create "$common/objects"
create "$common"
append_open "$common/config"
create "$admin"
append_open "$admin/HEAD"
append_open "$PWD/.git"

# The worktree's own files must stay writable.
if { echo edit > ./factory-worktree-edit-marker; } 2>/dev/null && rm -f ./factory-worktree-edit-marker; then
  echo "WORKTREE-EDIT-OK"
else
  echo "WORKTREE-EDIT-FAILED"
  unknown=1
fi

if [ "$leak" = 1 ]; then echo "RESULT LEAK"; exit 1; fi
if [ "$unknown" = 1 ]; then echo "RESULT INCONCLUSIVE"; exit 2; fi
echo "RESULT PASS"
exit 0
