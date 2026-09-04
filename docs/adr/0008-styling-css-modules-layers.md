# ADR-0008 Styling: CSS Modules + cascade layers, token custom properties

Status: accepted · 2026-09-04
`@layer reset, tokens, base, components, state, screens`. `state` holds `[data-inv]`/`[data-on]` so selection wins over component rules without `!important`. No Tailwind, no CSS-in-JS, no icon fonts. Fonts bundled from `@fontsource` via `packages/tokens`.
