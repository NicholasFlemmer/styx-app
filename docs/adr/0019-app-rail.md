# ADR-0019 Global rail, project rail, project nav; no project dropdown in the titlebar

Status: accepted · 2026-09-16 (owner request)

The handoff's shell is titlebar (wordmark · project dropdown · branch · palette · counters) over rail 56 · nav
168 · content, with the nav mixing app-level places (All projects, Approvals) and project places (Workspace,
Agents, Repo, Settings), and Settings holding both an App and a Project group in one inner nav.

The owner asked for a clear split: "an additional rail on the left of the project switcher for the global app
settings, then the project switcher, then the project details, options and settings; remove the select dropdown
project switcher at the top".

## Decision

Body = **app rail 56** · **project rail 56** · **project nav 168** · content (`apps/desktop/src/renderer/app/`).

- **App rail** (`AppRail.tsx`, `<nav aria-label="App">`, on `--bg` so the project rail reads as a second column):
  glyph tiles for what belongs to the app, not to a project — All projects, Approvals (corner + "n in the inbox"
  in the name while the inbox has rows), Tasks (opens the modeless task dialog; `aria-haspopup="dialog"` /
  `aria-expanded`), and App settings at the foot. Navigation tiles carry `aria-current="page"`.
- **Project rail** (`Rail.tsx`) is unchanged: the project switcher, drag and Alt+↑/↓ to reorder, the "+" menu.
- **Project nav** (`Nav.tsx`, `<nav aria-label="Sections">`) is the project: head = name and branch (the branch
  moved here from the titlebar, with a visually hidden "Branch" label), rows = Workspace · Agents · Repo ·
  Project settings, then the project's own action (Tech debt audit), footer = path and active grants. No Home,
  Approvals or Tasks rows any more.
- **Titlebar** keeps the wordmark, palette field and counters. The project dropdown is gone: the project rail and
  the palette's Projects scope (`Mod+P`) switch projects.
- **Settings** shows one group at a time: the app rail opens the App group (General by default; a specific app
  section set by a banner or the Diff screen is kept), the project nav opens the Project group (Targets by
  default). Each route swaps a stale section from the other group. A keyboard user inside the Settings landmark
  reaches the other group through the app rail or the project nav, not from within Settings; the project-file
  footer shows for the Project group only.
- **Design pane**: with 56px less, the device presets moved from the URL row to the Run row (right-aligned) so
  the URL field is never starved; the Run hint is one trimmed line.

## Consequences

- Every screen is 56px narrower in content. The prototype-baked visual baselines (`e2e/visual/__baseline__`) can no
  longer match any state with chrome: the shell itself differs from the prototype now. `pnpm visual` stays as a
  regression tool only after `pnpm visual:baseline` is re-baked from the app, and the prototype comparison for
  the shell is retired (discrepancy #85). Screens without chrome (onboarding) are unaffected.
- Window minimum stays 1100×680; the workspace's editor column is 56px narrower at that size.
- Tests: `AppRail.test.tsx`, updated `Settings.test.tsx`, `TaskDialog.test.tsx`; e2e specs reach app sections
  through the app rail; the axe pass over every state is clean.
