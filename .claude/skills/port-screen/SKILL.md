---
name: port-screen
description: Port one prototype screen from Styx.dc.html into apps/desktop/src/renderer/screens with pixel fidelity. Locates the artboard by data-screen-label, extracts inline-style recipes, maps them to @styx/ui components, implements over fixture data, runs the visual diff.
argument-hint: '<Workspace|Home|Agents|Repo|Approvals|Diff review|Settings|Onboarding>'
allowed-tools: Read, Grep, Glob, Edit, Write, Bash(pnpm:*), Bash(sed:*), Bash(grep:*), Bash(awk:*), Bash(python3:*)
---

# Port a screen: $ARGUMENTS

1. **Locate**: `grep -n 'data-screen-label="$0"' design/handoff/Styx.dc.html`; slice to the next label. Note which second-strip toggles affect it (empty, error, toast, popout, audit…).
2. **Inventory**: list every element top-to-bottom with its inline recipe (font, size, colour var, padding, borders, `data-inv`/`data-on`, `style-hover`). Keep it in a scratch note; do not commit it.
3. **Map** each element to an existing `@styx/ui` component + variant (spec §8 via `/spec-lookup 8`). Missing component → stop and run `/ui-component` first. Never inline a one-off.
4. **Data**: list the selectors needed (`packages/core/src/selectors`); add missing ones with tests. Screens read via `useModel`/`useUi` hooks and send `commands.*`; no fetching in components.
5. **Implement** `screens/<Screen>/<Screen>.tsx` + `.module.css` using layout vars (`--w-*`, `--h-*`). Copy strings from `@styx/core/copy`.
6. **Keyboard**: register screen shortcuts in `keys/bindings.ts` (spec §6); Esc via the overlay stack.
7. **States**: implement every state the strip shows, driven by fixture variants (`STYX_FIXTURE=<name>`), not toggles.
8. **Verify**: `pnpm typecheck && pnpm test -F @styx/desktop`, then `/visual-diff $0` for dark+light × mac+win. Iterate until under threshold.
9. Run the `design-fidelity-reviewer` subagent; fix findings.

Checklist: every element mapped to a §8 component · no raw hex · all `--w-*` widths used · copy verbatim · a11y per §9 (live regions, focus order, hit targets) · 4 visual variants pass · fixture states covered.
