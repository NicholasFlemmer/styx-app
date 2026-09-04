# @styx/ui

Component library recreated from spec §8 + the prototype. CSS Modules, tokens only, Storybook.

- One directory per component: `Button/Button.tsx`, `Button.module.css`, `Button.stories.tsx`, `Button.test.tsx`, `index.ts`; export from `src/index.ts`.
- Variants from spec §8 exactly. State via `inv`/`on` props → `data-inv`/`data-on` (set only when true); disabled via `disabled`/`aria-disabled`.
- CSS in `@layer components`: `var(--*)` only, `border-radius:0`, no shadows, no transitions on hover; motion only in Sheet/Modal/Toast with token durations. `check-design-css` hook rejects violations.
- Every component: focus ring from base layer, min hit 28px, keyboard reachable, axe clean in its story.
- Glyphs `▾ ✕ ⤢ ─ ☐` are inline SVG (`Icon`); `⏎ ⌘ ⇧ ⌥ ⌫ ⇥ → ↑ ↓ ● ■ ◆ ▲ ✓` are text.
- No app state, no IPC, no imports from apps/desktop. Props in, callbacks out.
- New component workflow: `/ui-component <Name>`.
