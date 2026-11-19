#!/bin/sh
# Sibling-project probe: another project's secrets must be unreadable from a verification sandbox, directly or by a
# recursive search. The caller plants a FACTORY-CANARY value in <dir>/.env outside the sandbox first and removes it
# after. Prints status words and paths only, never file contents.
# Exit 0: pass. Exit 1: a leak. Exit 2: inconclusive (the control or the target check could not prove denial).
#
#   sibling-probe.sh <sibling project dir> <readable control file>
set -u
export LC_ALL=C
[ $# -eq 2 ] || { echo "usage: $0 <sibling project dir> <readable control file>" >&2; exit 2; }
dir=$1
control=$2
leak=0
inconclusive=0

if cat -- "$control" >/dev/null 2>&1; then echo "CONTROL-OK"; else echo "CONTROL-FAILED $control"; inconclusive=1; fi

err=$(cat -- "$dir/.env" 2>&1 >/dev/null)
rc=$?
if [ $rc -eq 0 ]; then
  echo "READABLE $dir/.env"
  leak=1
else
  case $err in
  *"Operation not permitted"* | *"Permission denied"*) echo "DENIED $dir/.env" ;;
  *) echo "UNKNOWN $dir/.env"; inconclusive=1 ;;
  esac
fi

if grep -rlE 'FACTORY-CANARY-[0-9a-f]{32}' "$dir" "$(dirname -- "$dir")" 2>/dev/null | sed 's/^/INDIRECT-LEAK /' | grep .; then
  leak=1
else
  echo "INDIRECT-HIDDEN"
fi

if [ $leak -ne 0 ]; then echo "RESULT LEAK"; exit 1; fi
if [ $inconclusive -ne 0 ]; then echo "RESULT INCONCLUSIVE"; exit 2; fi
echo "RESULT PASS"
exit 0
