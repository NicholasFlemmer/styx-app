---
name: ui-component
description: Add or extend a component in packages/ui from the spec §8 inventory and prototype recipe, with CSS Modules from tokens, stories for every variant/state, keyboard/focus test, and axe check.
argument-hint: '<ComponentName> [variant]'
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(pnpm:*), Bash(grep:*), Bash(sed:*)
---

# UI component: $ARGUMENTS

1. Read the §8 row (`/spec-lookup 8`) and grep `design/handoff/Styx.dc.html` for 2–3 instances; copy the inline recipe (padding, font, border, hover, attributes).
2. Scaffold `packages/ui/src/<group>/<Name>/{<Name>.tsx,<Name>.module.css,<Name>.stories.tsx,<Name>.test.tsx,index.ts}`; export from `src/index.ts`.
3. Props: semantic props + `inv?`, `on?`, `disabled?`, `className?`; render `data-inv`/`data-on` only when true; forward `ref`.
4. CSS in `@layer components`, token vars only; hover = instant `background: var(--s2)`; no radius/shadow/transition. Hit target ≥28px (`::after` inset for compact buttons).
5. Stories: one per variant × state + a `Matrix` story; a11y addon enabled.
6. Test: renders, keyboard activation, `aria-*`, focus ring visibility.
7. `pnpm test -F @styx/ui && pnpm typecheck` and `pnpm storybook:test` when available.
