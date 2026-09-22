# User simulation · home-settings

Run 2026-09-22T07:30:24.191Z · 47/47 steps passed · 45 s · fixture `demo`, STYX_NOW 1773308580000, fake CLIs on PATH, no STYX_E2E.

## Findings

### 1. [polish] Settings › Policies › Export is a one-option select that does nothing

- Repro: Settings › Policies → the Export row
- Expected: an action (the Policies tab under Approvals has a real "Export JSON" button) or a plain value, not a dropdown
- Observed: an enabled Select whose only option is "JSON"; choosing it changes nothing (disabled=false)
- Where: apps/desktop/src/renderer/screens/Settings/rows.ts policiesRows (`fixed('export', …)`), prototype settingsRowsMap

## Steps

| # | Step | Result | Note |
| --- | --- | --- | --- |
| 1 | Home: the four counters read what the fixture holds (02 · 03 · 02 · 05) | ok (111 ms) | 02 · 03 · 02 · 05 |
| 2 | Home: five project rows in rail order with agents · targets · last activity | ok (12 ms) | 5 rows |
| 3 | Home: the activity feed is newest first (2m … 1d) | ok (5 ms) | 2m 3m 9m 31m 1h 1d |
| 4 | Home: the add row offers New project · Add from recent · Open folder · Clone URL | ok (9 ms) |  |
| 5 | Click a project row → that project's Workspace, nav named after it | ok (314 ms) |  |
| 6 | Rail tiles switch projects and the nav follows; from Home a tile lands in Workspace | ok (353 ms) |  |
| 7 | Keyboard: Mod+P opens the palette in the Projects scope and Enter switches (spec §6) | ok (601 ms) | 5 project rows in scope |
| 8 | Settings › App: all seven sections open from the app rail with the right heading | ok (507 ms) | tooltip vs heading: General settings → General, Agent connections → Agents |
| 9 | General: Theme changes data-theme at once; Notify and Launch at login take a value | ok (1998 ms) | system → dark |
| 10 | Editor: Open files in · Fallback editor · Line endings · Screen reader · Track agent edits | ok (1413 ms) | Line endings wrote project.json of acme-shop while the page scope reads "app" |
| 11 | Editor: the fallback editor drives "Open in … too" in the New project modal | ok (60 ms) |  |
| 12 | Agent connections: five rows with the fixture's accounts and states | ok (96 ms) | claude:connected codex:connected gemini:signed-out cursor:unverified shell:shell |
| 13 | Agent connections: Rescan finds the CLIs on the PATH (the e2e fakes take over the fixture rows) | ok (2416 ms) | codex 0.154.0 · claude 99.0.0 · cursor not installed |
| 14 | Agent connections: Verify · Codex reads the account through the app-server; Verify · Claude Code too | ok (407 ms) | gemini after rescan: signed-out |
| 15 | Agent connections: the preference rows (default agent, worktree per agent, shell, detected CLIs, binaries) | ok (569 ms) | 2 "{cli} binary" rows; claude offers 6: claude 99.0.0 · PATH \| claude 2.1.278 · PATH \| claude 2.1.15 · PATH \| claude 2.1.270 · VS Code extension \| claude 2.1.273 · VS Code extension \| claude 2.1.278 · VS Code extension |
| 16 | Connect agent · Cursor (not installed): Install · Install guide · Locate binary · path field · where it looked | ok (120 ms) | searched folders listed |
| 17 | Locate binary: a file that is not the CLI is refused with the reason inline | ok (222 ms) | /bin/ls did not run as Cursor agent (no version reported). Pick the Cursor agent executable itself. // /Users/nic/.styx/worktrees/STYX/agent-claude-2/apps/desktop/e2e/fixtures/bin/codex is the Codex CLI, not Cursor agent. |
| 18 | Path field: "Use" with a wrong path tells the user why (like Locate binary does) | ok (1554 ms) | inline reason |
| 19 | Escape closes the Connect agent modal and focus returns to the row's Connect button | ok (9 ms) | cursor:Connect |
| 20 | Connect agent · Claude Code (installed): version/location, identity, Sign in, Verify, Done | ok (6997 ms) | Signed in as fake@example.com |
| 21 | Skills: reads the fixture home (never ~/.claude); three installed rows, search, agent filter | ok (675 ms) | Claude filter → 2 rows |
| 22 | Skills: the catalogue lists three, Read opens the skill text with the security line | ok (122 ms) |  |
| 23 | Skills: install xlsx for Codex only → lands in the fixture home, toast, listed; Remove takes it back | ok (194 ms) |  |
| 24 | Keychain & secrets: Store · MFA words follow the platform; Inject as takes a value | ok (311 ms) | macOS Keychain · Touch ID |
| 25 | Policies: Auto-approve staging reads toggles the builtin rule; idle expiry and Export are read-only | ok (324 ms) | idle expiry "1 hour", export options JSON |
| 26 | Shortcuts: the four rows match styx-tokens.json (palette · switch project · focus agent · approve/deny) | ok (33 ms) | 4 rows shown of 14 token shortcuts (prototype lists four) |
| 27 | Project nav: Targets · Agent defaults · Env & secrets open the project sections with the file note | ok (176 ms) |  |
| 28 | Agent defaults: Default agent → Codex, Model, Auto-approve edits reach .styx/project.json; Reset appears | ok (1498 ms) | model options: default, gpt-6-astra, gpt-5.5 |
| 29 | Agent defaults: Permission mode, Styx tasks mode and Effort reach the file the page names | ok (1167 ms) |  |
| 30 | Agent defaults: lane rows (fetch · bring in base · after every turn · merging · land) take values and persist in SQLite | ok (1656 ms) | in project.json: none (machine-local, under a header that names the committed file) |
| 31 | Agent defaults: Reset on an overridden row returns the default and the file loses the key | ok (357 ms) |  |
| 32 | Env & secrets: .env source · Share with agents (→ project.json, Reset) · Committed file | ok (2828 ms) |  |
| 33 | Relaunch (same profile) → General / Editor / Keychain / Policies / Agent defaults values are still there | ok (1834 ms) |  |
| 34 | Rail "+": a four-row menu; ↓ moves, Esc closes and hands focus back to the tile | ok (87 ms) |  |
| 35 | New project: an empty Name keeps the modal open and puts focus on Name; nothing is created | ok (577 ms) | no error text; focus is the only signal (prototype behaviour) |
| 36 | New project: an existing non-empty folder is refused with a toast; the modal stays | ok (133 ms) | invalid-input Styx · now /var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-sim-home-n48ufB/taken exists and is not empty |
| 37 | New project · Empty folder + git init → on Home and in the rail, with a real repo on disk | ok (927 ms) | d205fc2 Initial commit · row: sim-empty · /var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-sim-home-n48ufB/sim-empty · main · — · — · now |
| 38 | New project · "Agent scaffolds it" with Codex as the default agent → Workspace with the session running | ok (1230 ms) | session codex is needs-you; the fake replays pong + an approval, it scaffolds nothing (folder holds README.md + .git) |
| 39 | The new session's ask shows on Home (needs you 03, row lists Codex); Allow lets the turn finish | ok (6320 ms) |  |
| 40 | Remove from sidebar (rail right-click) → gone from the rail and Home; the folder stays on disk | ok (176 ms) | folder kept; 0 live session rows left behind |
| 41 | Add from recent: the scan lists this machine's repos / recents, nothing pre-checked, Add disabled | ok (1413 ms) | 48 rows · sources {"scan":41,"claude":7} · e.g. "no remote" |
| 42 | Add from recent: pick one → "Add 1" → its Workspace; then Cancel adds nothing | ok (13 ms) | only this machine's own repos are offered (48); none added on purpose |
| 43 | Cleanup: remove the added repo and sim-empty from the sidebar | ok (104 ms) |  |
| 44 | Relaunch restores the last screen, project and per-project session (README: ui.screen / projectId) | ok (3147 ms) |  |
| 45 | Escape closes New project / Add from recent / the palette and hands focus back to the invoker | ok (276 ms) |  |
| 46 | Window: the minimum is enforced at 1100×680 | ok (406 ms) | asked 900×500, got 1100×680 |
| 47 | At 1100×680: Home, Workspace and Agent defaults have no overflow or label/control collisions | ok (1531 ms) |  |
