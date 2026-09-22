# User simulation · onboarding-shell

Run 2026-09-22T07:04:54.761Z · 14/14 steps passed · 9 s · fixture `empty`, STYX_NOW 1773308580000, fake CLIs on PATH, no STYX_E2E.

## Findings

None.
## Steps

| # | Step | Result | Note |
| --- | --- | --- | --- |
| 1 | first run (onboardingDone=false) opens on onboarding step 1 (Editor) with the four-step strip | ok (164 ms) |  |
| 2 | Editor: the detected IDE rows and the import toggles are real controls | ok (68 ms) | 9 toggles |
| 3 | Continue → Projects: the scan finds repos or says so; the add row is present | ok (46 ms) | 0 repo rows |
| 4 | Back returns to step 1 with the toggles as left | ok (77 ms) |  |
| 5 | Continue → Agents: every CLI row with its state from the fakes; Continue → Targets: the provider grid | ok (83 ms) | 6 providers |
| 6 | Finish lands on Home; a reload does not show onboarding again (flag persisted) | ok (148 ms) |  |
| 7 | window minimum: 1100×680 is enforced and nothing overflows at it | ok (78 ms) |  |
| 8 | palette: Mod+K opens it with Actions · Agents · Projects, typing filters, ⏎ switches project, Escape closes and returns focus | ok (399 ms) |  |
| 9 | Mod+P (switch project) and Mod+1..4 (focus agent) do what the token map says | ok (165 ms) |  |
| 10 | Mod+Shift+T cycles the theme (dark → light → system) and Settings › General agrees | ok (91 ms) | html dark → light; row reads "Theme System Dark Light" |
| 11 | Mod+Shift+N opens Spawn agent; Escape closes it and focus returns | ok (316 ms) | focus before: <button type="button" class="_tile_bq0dt_2 _project_bq0dt_21" title="acme-shop"  · after: <button type="button" class="_tile_bq0dt_2 _project_bq0dt_21" title="acme-shop"  |
| 12 | Mod+Shift+O pops the chat out and docks it back | ok (3180 ms) |  |
| 13 | error fixture: the banners (auth expired · CLI missing · conflict) each carry a resolving action | ok (105 ms) | 3 banners: AWS acme-prod: credentials expired 2h ago. Agents requesting it are paused. Reconnect codex not found on PATH. 1 session cannot start. Install guide fix/checkou |
| 14 | the CLI-missing banner's action opens Settings › Agents; the conflict banner's action goes to Repo | ok (700 ms) |  |
