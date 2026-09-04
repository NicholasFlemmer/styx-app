#!/bin/sh
cd "$CLAUDE_PROJECT_DIR" || exit 0
[ -d node_modules ] || exit 0
files=$( { git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard; } | grep -E '\.(ts|tsx)$' )
pkgs=$(echo "$files" | sed -nE 's#^(apps/[^/]+|packages/[^/]+)/.*#\1#p' | sort -u)
[ -z "$pkgs" ] && exit 0
fail=0
for p in $pkgs; do
  out=$(pnpm --filter "./$p" typecheck 2>&1) || { fail=1; echo "typecheck FAILED in $p:"; echo "$out" | grep -E 'error TS' | head -n 15; }
done
[ $fail -eq 0 ] && echo "typecheck OK: $(echo $pkgs | tr '\n' ' ')"
exit 0
