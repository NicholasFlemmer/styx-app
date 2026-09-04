#!/bin/sh
f=$(jq -r '.tool_input.file_path // empty')
case "$f" in */packages/ui/src/*/*.tsx) ;; *) exit 0;; esac
case "$f" in *.stories.tsx|*.test.tsx|*/styles/*) exit 0;; esac
d=$(dirname "$f"); b=$(basename "$f" .tsx)
[ -f "$d/$b.stories.tsx" ] || echo "Reminder: $b has no $b.stories.tsx yet. Every @styx/ui component needs a story per variant/state (/ui-component)."
exit 0
