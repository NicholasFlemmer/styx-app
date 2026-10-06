# @styx/ui

Component library: CSS Modules, tokens only, Storybook. Started from the handoff spec §8 inventory and prototype;
ADR-0027/0028 added the lane-era components (`message/`: LaneHeader, TurnResult, Receipt, StepList, OpenTurn …;
`layout/`: LaneRow, DeviceFrame …).

- Grouped by kind: `primitives/`, `layout/`, `chrome/`, `message/`, `overlay/`, `feedback/`, `arcade/`, `hooks/`.
  One directory per component: `Button/Button.tsx`, `Button.module.css`, `Button.stories.tsx`, `Button.test.tsx`
  (keyboard/focus/aria behaviour, where there is any), `index.ts`; re-export from the group's `index.ts` and
  `src/index.ts`.
- State via `inv`/`on` props → `data-inv`/`data-on` (set only when true); disabled via `disabled`/`aria-disabled`.
- CSS in `@layer components`: `var(--*)` only, `border-radius: 0`, no shadows, no transitions on hover; motion only in
  Sheet/Modal/Toast with token durations. Sentence-case labels (ADR-0027 §6). The `check-design-css` hook rejects
  violations; full rules in `.claude/rules/css-tokens.md`.
- Every component: focus ring from the base layer, min hit 28px, keyboard reachable, axe clean in its stories
  (`pnpm storybook:test` runs axe on every story; CI gates on it).
- Glyphs `▾ ✕ ⤢ ─ ☐` are inline SVG (`Icon`); `⏎ ⌘ ⇧ ⌥ ⌫ ⇥ → ↑ ↓ ● ■ ◆ ▲ ✓` are text.
- No app state, no IPC, no imports from apps/desktop. Props in, callbacks out.
- New component workflow: `/ui-component <Name>`.
