#!/bin/sh
cd "$CLAUDE_PROJECT_DIR" || exit 0
[ -f .planning/STATE.md ] && { echo "## .planning/STATE.md"; sed -n '1,40p' .planning/STATE.md; }
echo "## git"; git status --short 2>/dev/null | head -n 20
