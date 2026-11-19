#!/bin/sh
# Network probe for a verification sandbox: tries each target and checks it is reachable or blocked as the phase's
# profile says. Prints one status line per target and a RESULT, never a proxy credential.
# Exit 0: pass. Exit 1: a leak (something that must be blocked was reached). Exit 2: inconclusive (something that
# must be reachable was not, so a block proves nothing). A leak wins over inconclusive.
#
#   network-probe.sh setup <allowed url> <denied url>
#     The setup phase: the egress proxy (from HTTPS_PROXY) reaches allowed hosts only, nothing bypasses it, and it
#     refuses a client without its credential.
#   network-probe.sh serve <self url> <other loopback url> <outside url>
#     Beside the preview: its own port only.
#   network-probe.sh none <self url> <other loopback url> <outside url>
#     No network at all, not even the preview's port.
set -u
export LC_ALL=C
leak=0
unknown=0

# Exit 0 when curl got any HTTP answer; prints only the status code.
reach() { curl -sS -m 8 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null; }

must_reach() {
  label=$1
  shift
  if code=$(reach "$@"); then echo "REACHED $label $code"; else echo "UNREACHABLE $label"; unknown=1; fi
}

must_block() {
  label=$1
  shift
  if code=$(reach "$@"); then echo "LEAK $label $code"; leak=1; else echo "BLOCKED $label"; fi
}

command -v curl >/dev/null 2>&1 || { echo "NO-CURL"; echo "RESULT INCONCLUSIVE"; exit 2; }

case ${1:-} in
setup)
  [ $# -eq 3 ] || { echo "usage: $0 setup <allowed url> <denied url>" >&2; exit 2; }
  proxy=${HTTPS_PROXY:-}
  case $proxy in
  http://*@127.0.0.1:*) ;;
  *) echo "NO-PROXY"; echo "RESULT INCONCLUSIVE"; exit 2 ;;
  esac
  must_reach "allowed host through the proxy" "$2"
  must_block "denied host through the proxy" "$3"
  must_block "allowed host bypassing the proxy" --noproxy '*' "$2"
  must_block "public address bypassing the proxy" --noproxy '*' https://1.1.1.1/
  must_block "the proxy without its credential" -x "http://${proxy##*@}" "$2"
  ;;
serve | none)
  [ $# -eq 4 ] || { echo "usage: $0 $1 <self url> <other loopback url> <outside url>" >&2; exit 2; }
  if [ "$1" = serve ]; then must_reach "the preview's own port" "$2"; else must_block "the preview's own port" "$2"; fi
  must_block "another loopback port" "$3"
  must_block "an outside host" "$4"
  must_block "a public address" https://1.1.1.1/
  ;;
*)
  echo "usage: $0 setup|serve|none ..." >&2
  exit 2
  ;;
esac

if [ $leak -ne 0 ]; then echo "RESULT LEAK"; exit 1; fi
if [ $unknown -ne 0 ]; then echo "RESULT INCONCLUSIVE"; exit 2; fi
echo "RESULT PASS"
exit 0
