---
name: spec-lookup
description: Answer "what does the spec/prototype say about X" by reading the Styx handoff HTML with tags stripped. Use before implementing any screen, component, copy, shortcut, or state rule.
argument-hint: '<section number | topic | screen label>'
allowed-tools: Bash(sed:*), Bash(grep:*), Bash(awk:*), Bash(head:*), Bash(python3:*), Read, Grep
---

# Spec lookup

Handoff lives in `design/handoff/`. Files: `Styx Spec.dc.html` (spec §1–§11), `Styx.dc.html` (prototype, pixel-final), `styx-tokens.css/json`, `UX Research Memo.dc.html`.

## Strip tags

```
python3 - "$CLAUDE_PROJECT_DIR/design/handoff/Styx Spec.dc.html" <<'PY'
import re,html,sys
t=open(sys.argv[1]).read()
t=re.sub(r'<script.*?</script>','',t,flags=re.S); t=re.sub(r'<style.*?</style>','',t,flags=re.S)
t=re.sub(r'<[^>]+>','\n',t); print(html.unescape(re.sub(r'\n\s*\n+','\n',t)))
PY
```

Section index: pipe through `grep -nE '^[0-9]+\. '`. Slice a section: `awk '/^8\. /{f=1} /^9\. /{f=0} f'`.

## Prototype markup

- Screens: `grep -n 'data-screen-label="Home"' design/handoff/Styx.dc.html`, then `sed -n '<start>,<next-label>p'`. Artboards are sequential; markup lines 23–508, state script 509–736.
- The prototype has zero CSS classes: every recipe is an inline `style="…"`; `style-hover="…"` is the hover state; `data-inv`/`data-on` are the selection attributes.
- Flow/state strips (onboarding, diff, connect, spawn, new project, empty, error, toast, popout, audit) are prototype chrome, not app UI.

## Report

Quote exact text, cite file and line, note if prototype and spec disagree (prototype wins for visuals, spec for behaviour; log to `docs/handoff-discrepancies.md`). Never paraphrase copy.
