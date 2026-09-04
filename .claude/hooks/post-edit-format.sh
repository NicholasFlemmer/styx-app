#!/bin/sh
f=$(jq -r '.tool_input.file_path // empty'); [ -z "$f" ] && exit 0
case "$f" in *.ts|*.tsx|*.css|*.json|*.mjs|*.md) ;; *) exit 0;; esac
case "$f" in */node_modules/*|*/design/handoff/*|*/.planning/*|*/__baseline__/*) exit 0;; esac
cd "$CLAUDE_PROJECT_DIR" || exit 0
npx prettier --log-level warn --write "$f" >/dev/null 2>&1
case "$f" in *.ts|*.tsx) npx eslint --fix --no-warn-ignored "$f" 2>&1 | tail -n 20 >&2 ;; esac
exit 0
