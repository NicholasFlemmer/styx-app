# User simulation · onboarding-shell

Run 2026-09-21T17:01:47.565Z · 14/14 steps passed · 14 s · fixture `empty`, STYX_NOW 1773308580000, fake CLIs on PATH, no STYX_E2E.

## Findings

### 1. [minor] Mod+Shift+T can be a no-op: the cycle passes through a step that looks identical

- Repro: theme setting "system" on an OS that resolves to dark; press Mod+Shift+T once
- Expected: the window visibly changes theme on every press (skip the step that resolves to the current look)
- Observed: setting went system → dark, data-theme stayed dark
- Where: apps/desktop/src/renderer/keys/bindings.ts cycleTheme

## Steps

| # | Step | Result | Note |
| --- | --- | --- | --- |
| 1 | first run (onboardingDone=false) opens on onboarding step 1 (Editor) with the four-step strip | ok (263 ms) |  |
| 2 | Editor: the detected IDE rows and the import toggles are real controls | ok (92 ms) | 9 toggles |
| 3 | Continue → Projects: the scan finds repos or says so; the add row is present | ok (46 ms) | 0 repo rows |
| 4 | Back returns to step 1 with the toggles as left | ok (76 ms) |  |
| 5 | Continue → Agents: every CLI row with its state from the fakes; Continue → Targets: the provider grid | ok (69 ms) | 6 providers |
| 6 | Finish lands on Home; a reload does not show onboarding again (flag persisted) | ok (164 ms) |  |
| 7 | window minimum: 1100×680 is enforced and nothing overflows at it | ok (72 ms) |  |
| 8 | palette: Mod+K opens it with Actions · Agents · Projects, typing filters, ⏎ switches project, Escape closes and returns focus | ok (398 ms) |  |
| 9 | Mod+P (switch project) and Mod+1..4 (focus agent) do what the token map says | ok (162 ms) |  |
| 10 | Mod+Shift+T cycles the theme (dark → light → system) and Settings › General agrees | ok (5111 ms) | html dark → dark; row reads "Theme System Dark Light" |
| 11 | Mod+Shift+N opens Spawn agent; Escape closes it and focus returns | ok (316 ms) | focus before: <button type="button" class="_tile_bq0dt_2 _project_bq0dt_21" title="acme-shop"  · after: <button type="button" class="_tile_bq0dt_2 _project_bq0dt_21" title="acme-shop"  |
| 12 | Mod+Shift+O pops the chat out and docks it back | ok (3176 ms) |  |
| 13 | error fixture: the banners (auth expired · CLI missing · conflict) each carry a resolving action | ok (151 ms) | 3 banners: AWS acme-prod: credentials expired 2h ago. Agents requesting it are paused. RECONNECT codex not found on PATH. 1 session cannot start. INSTALL GUIDE fix/checkou |
| 14 | the CLI-missing banner's action opens Settings › Agents; the conflict banner's action goes to Repo | ok (731 ms) |  |
