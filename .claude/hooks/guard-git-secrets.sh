#!/bin/sh
cmd=$(jq -r '.tool_input.command // empty')
echo "$cmd" | grep -qE '(^|[;&|] *)git (add|commit)' || exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0
bad=$( { git diff --cached --name-only 2>/dev/null; echo "$cmd" | grep -oE '(\S+\.(env|pem|key|p12)|\.env(\.\S+)?)'; } | grep -E '(^|/)\.env(\..*)?$|\.(pem|key|p12)$|credentials\.json$' | grep -v '\.env\.example$' )
if [ -n "$bad" ]; then echo "Blocked: secret-looking files in commit: $bad" >&2; exit 2; fi
if git diff --cached 2>/dev/null | grep -qE '(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[bp]-[0-9A-Za-z-]+)'; then
  echo "Blocked: staged diff contains a credential-shaped string. Remove it and use the keychain (credentialRef)." >&2; exit 2
fi
exit 0
