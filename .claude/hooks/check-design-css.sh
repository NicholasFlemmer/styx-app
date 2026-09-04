#!/bin/sh
# Design-fidelity guard for UI and renderer files. Exit 2 = block with feedback.
f=$(jq -r '.tool_input.file_path // empty'); [ -z "$f" ] && exit 0
case "$f" in */packages/ui/src/*.css|*/packages/ui/src/*.tsx|*/src/renderer/*.css|*/src/renderer/*.tsx) ;; *) exit 0;; esac
case "$f" in */packages/tokens/*|*.stories.tsx|*.test.tsx) exit 0;; esac
[ -f "$f" ] || exit 0
v=""
grep -nE '(^|[^&])#[0-9a-fA-F]{3,8}\b' "$f" | grep -vE 'var\(--|//|/\*|id=|href=' >/dev/null && v="$v raw-hex-color"
grep -nE 'border-radius\s*:\s*[1-9]' "$f" >/dev/null && v="$v border-radius"
grep -nE 'box-shadow\s*:' "$f" | grep -v 'none' >/dev/null && v="$v box-shadow"
grep -nE 'linear-gradient|radial-gradient' "$f" >/dev/null && v="$v gradient"
grep -nE 'transition\s*:' "$f" | grep -vE 'transform|opacity|none' >/dev/null && v="$v hover-transition"
grep -nE "font-family\s*:" "$f" | grep -vE 'var\(--font-(ui|mono)\)|inherit' >/dev/null && v="$v font-family-literal"
grep -nE 'className=[^>]*\b(active|selected)\b' "$f" >/dev/null && v="$v active-class(use data-inv/data-on)"
if [ -n "$v" ]; then
  echo "Design-fidelity violations in $f:$v. Use tokens (var(--*)), radius 0, no shadow, data-inv/data-on. See packages/ui/CLAUDE.md." >&2
  exit 2
fi
exit 0
