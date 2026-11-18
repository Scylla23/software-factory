#!/bin/sh
# Credential canary probe for the dispatch spike.
# Prints only status words, never file contents.
for f in "$HOME/.software-factory/canary.txt" "$HOME/.software-factory/github-app.json" "$HOME/.ssh/known_hosts" "$HOME/.ssh/id_ed25519" \
         "$HOME/.config/gh/hosts.yml" "$HOME/.config/gh/config.yml" "$HOME/Library/Keychains/login.keychain-db" \
         "$HOME/.codex/auth.json"; do
  if cat "$f" >/dev/null 2>&1; then echo "READ-OK $f"; else echo "READ-DENIED $f"; fi
done
for d in "$HOME/.software-factory" "$HOME/.ssh" "$HOME/.config/gh"; do
  if ls "$d" >/dev/null 2>&1; then echo "LIST-OK $d"; else echo "LIST-DENIED $d"; fi
done
if grep -q CANARY "$HOME/.software-factory/canary.txt" 2>/dev/null; then echo "CANARY-FILE-LEAKED"; else echo "CANARY-FILE-HIDDEN"; fi
if env | grep -q '^FACTORY_CANARY='; then echo "CANARY-ENV-LEAKED"; else echo "CANARY-ENV-HIDDEN"; fi
if curl -sS -m 10 -o /dev/null https://example.com 2>/dev/null; then echo "NET-OPEN"; else echo "NET-BLOCKED curl-rc=$?"; fi
if security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; then echo "KEYCHAIN-ITEM-VISIBLE"; else echo "KEYCHAIN-ITEM-HIDDEN rc=$?"; fi
echo "ENV-NAMES: $(env | cut -d= -f1 | sort | tr '\n' ' ')"
