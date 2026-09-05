---
name: visual-diff
description: Run the Playwright screenshot harness comparing the Electron app to prototype baselines for a screen (dark/light × mac/win) and interpret the diff image.
argument-hint: '<screen|state> [--update-baseline]'
allowed-tools: Bash(pnpm:*), Read, Glob
---

# Visual diff: $ARGUMENTS

1. From apps/desktop run `env -u ELECTRON_RUN_AS_NODE npx playwright test -c e2e/playwright.config.ts --project visual --grep "$0"` (the `pnpm visual` wrapper does not forward `--grep`); it launches Electron with `STYX_FIXTURE=demo STYX_SCREEN=<screen>` at 1280×800 and compares against `apps/desktop/e2e/visual/__baseline__/<state>-<theme>-<chrome>.png` (pixelmatch, threshold 0.1, ≤0.2% differing pixels; native chrome regions masked).
2. Read `apps/desktop/e2e/visual/output/<state>-*-diff.png`; describe where red pixels cluster and map to component/CSS.
3. Common causes: font not loaded (fallback metrics), collapsed 1px hairline, missing letter-spacing, missing `tabular-nums`, scrollbar width, wrong `--w-*`, sub-pixel rounding.
4. Baselines are baked from `design/handoff/Styx.dc.html` by `pnpm visual:baseline`; regenerate only when the handoff changes, with a commit message explaining why.
