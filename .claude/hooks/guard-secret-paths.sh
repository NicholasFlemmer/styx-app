#!/bin/sh
f=$(jq -r '.tool_input.file_path // empty')
case "$f" in
  *.pem|*.key|*.p12|*/.ssh/*|*/design/handoff/*|*/e2e/visual/__baseline__/*|*/.planning/STATE.md)
    echo "Blocked write to protected path: $f" >&2; exit 2;;
  *.env|*/.env.*) case "$f" in *.env.example) ;; *) echo "Blocked write to env file: $f" >&2; exit 2;; esac;;
esac
c=$(jq -r '.tool_input.content // .tool_input.new_string // empty')
echo "$c" | grep -qE '(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' && { echo "Blocked: content contains a credential-shaped string." >&2; exit 2; }
exit 0
