# User simulation · agents-approvals

Run 2026-09-22T07:42:03.862Z · 42/43 steps passed · 53 s · fixture `demo`, STYX_NOW 1773308580000, fake CLIs on PATH, no STYX_E2E.

## Findings

### 1. [polish] Three "needs you" numbers on one screen count three different things

- Repro: Launch on the Agents board over the demo fixture; compare the titlebar, the Approvals rail tile and the dock badge
- Expected: One number for "things waiting on me", or labels that say what differs
- Observed: titlebar "02 needs you" (sessions in needs-you) · Approvals tile "3 in the inbox" (requested grants, two of which have no session ask) · dock badge "2" (open asks)
- Where: packages/core/src/selectors/counts.ts needsYouCount · selectors/inbox.ts inboxRows · main services/notification-service.ts (openAll asks)

### 2. [minor] Escape closes the grant sheet but focus does not return to the card button that opened it

- Repro: Agents board → focus + click "Review grant" on the Codex card → Escape
- Expected: Focus back on "Review grant" (README: Escape returns focus to the invoker)
- Observed: active element text "STYXSwitch, spawn, deploy, grant…⌘K02 needs you02 lockedASBLINCXSA+acme-shopBranch test/flakyWorkspaceAgents3Repo4 wtTargetsAgent defaultsEnv & secretsTech debt audit/var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-e2e-6mPALn/demo-repos/acme-shop2 grants activeFiles.claude/skills/release-notes/SKILL.mdapp.tscart.tscheckout.tsorders.test.ts●pay.tspromo.tsREADME.mdChanges · 1Morders.test.tsOpen in VS CodeCodeDesign↑Publish▲Deploy toorders.test.ts✕12345678910111213import { checkout } from './checkout'test('orders total', async () => {  const r = await checkout({ items: [{ price: 2 }, { price: 3 }] })  expect(r.total).toBe(5)  expect(r.ok).toBe(true)})test('orders retry once', async () => {  const r = await checkout({ items: [{ price: 1 }] })  expect(r.total).toBe(1)})TERMINAL · test/flaky.xterm .xterm-scrollable-element > .scrollbar > .slider {
  background: #c9cdc233;
}
.xterm .xterm-scrollable-element > .scrollbar > .slider:hover {
  background: #c9cdc266;
}
.xterm .xterm-scrollable-element > .scrollbar > .slider.active {
  background: #c9cdc280;
}test/flakyVercel prod · open 58mSupabase · lockedMonaco · LF · TSLn 1, Col 1Claude✕Codex!✕Gemini✕+codex · test/flaky · 3m · waiting on youFix the flaky order test and make sure the schema matches prod.The test fails because migration 0042 was never applied to prod. I need to read the prod schema and apply it.Access request · Supabase prodScope: read schema, write. No grant on file for this target.Review requestDenyStop · escattachQueue"
- Where: apps/desktop/src/renderer/overlays (invoker memory) / screens/Agents/Agents.tsx runCta

### 3. [major] A command approval is on the board, in the toast and on the badge, but not in the Approvals inbox

- Repro: Spawn Codex from the board with "ping"; the fake asks to run a command → look at Approvals › Inbox
- Expected: The README: an ask renders inline in chat, on the board, in the Approvals inbox, as a toast and as a badge; approving anywhere resolves it everywhere
- Observed: inbox corner still 3 (the inbox lists requested grants only); the ask kind is "decision"
- Where: packages/core/src/selectors/inbox.ts inboxRows (grants with state requested) · screens/Approvals/Approvals.tsx Inbox

### 4. [polish] The needs-you toast outlives the ask it announced

- Repro: Send "ping" to the spawned Codex session → toast → answer the ask in the chat
- Expected: The toast goes away once its ask is answered (it has nothing left to review)
- Observed: The toast stays until its 8 s TTL
- Where: apps/desktop/src/renderer/features/toast/ToastHost.tsx (no resolve listener)

### 5. [minor] No way in the chat to end a session so it lands in Done (✕ archives it, Stop only interrupts the turn)

- Repro: Workspace → a running Codex chat → look for a way to end the session without losing it from the board
- Expected: An "End session" action that finishes the session (Done column, Reopen later)
- Observed: Only "Stop · esc" (session.interrupt) and the tab ✕ (session.close: stop + archive, never shown in Done)
- Where: apps/desktop/src/renderer/features/chat/ChatPane.tsx (session controls / closeSession)

### 6. [polish] demo fixture: an inbox row from a session that is already done has no chat to review it in

- Repro: demo fixture › Approvals › Inbox › Review on Cursor → Vercel preview
- Expected: a live session behind every requested grant (the app cancels requests when a session ends)
- Observed: Review opened the target's project without a grant sheet; the Cursor session is paused
- Where: packages/core/src/fixtures/demo.ts grant vercelPreviewCursor (prototype content)

### 7. [polish] Settings › Policies shows the prototype’s three fixed rows; custom rules live only under Approvals › Policies

- Repro: Add a rule (+ Rule) → app rail › Policies
- Expected: a pointer to Approvals › Policies would help; the spec’s rows are as designed
- Observed: rows: autoApproveStagingReads, grantIdleExpiry, export
- Where: apps/desktop/src/renderer/screens/Settings/rows.ts policiesRows (prototype settingsRowsMap)

### 8. [minor] Run again + Stop hides the previous finished report: Tasks keeps one entry per project

- Repro: Finish a Tech debt audit → Run again → Stop task → Tasks list
- Expected: The finished report stays reachable (or the stopped run is marked separately)
- Observed: one entry "Tech debt audit · acme-shop" reading Stopped; the earlier report is gone from the list
- Where: apps/desktop/src/renderer/features/tasks/TaskDialog.tsx entries (Map by taskKey)

## Steps

| # | Step | Result | Note |
| --- | --- | --- | --- |
| 1 | detect.clis finds the fake Codex and Gemini on PATH | ok (1948 ms) | codex "0.154.0" · gemini "0.39.1" |
| 2 | the board shows the fixture in Needs you / Working / Done with the copy texts | ok (112 ms) | needs 2 · working 4 · done 2 |
| 3 | titlebar, rail corner and dock badge read the fixture | ok (10 ms) | needs 2 · locked 2 · inbox 3 · badge "2" |
| 4 | scope: the project nav shows only this project, the app rail every project | ok (148 ms) | project scope: 4 cards, rail data-on=none · all: 8 cards |
| 5 | Open on a Working card lands in that session's chat | ok (218 ms) |  |
| 6 | Review grant on the Codex card opens the grant sheet; Escape closes it and focus returns | ok (161 ms) | grant button "Grant 1h · Touch ID" · focus after Escape: "STYXSwitch, spawn, deploy, grant…⌘K02 needs you02 lockedASBLINCXSA+acme-shopBranch test/flakyWorkspaceAgents3Repo4 wtTargetsAgent defaultsEnv & secretsTech debt audit/var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-e2e-6mPALn/demo-repos/acme-shop2 grants activeFiles.claude/skills/release-notes/SKILL.mdapp.tscart.tscheckout.tsorders.test.ts●pay.tspromo.tsREADME.mdChanges · 1Morders.test.tsOpen in VS CodeCodeDesign↑Publish▲Deploy toorders.test.ts✕12345678910111213import { checkout } from './checkout'test('orders total', async () => {  const r = await checkout({ items: [{ price: 2 }, { price: 3 }] })  expect(r.total).toBe(5)  expect(r.ok).toBe(true)})test('orders retry once', async () => {  const r = await checkout({ items: [{ price: 1 }] })  expect(r.total).toBe(1)})TERMINAL · test/flaky.xterm .xterm-scrollable-element > .scrollbar > .slider {   background: #c9cdc233; } .xterm .xterm-scrollable-element > .scrollbar > .slider:hover {   background: #c9cdc266; } .xterm .xterm-scrollable-element > .scrollbar > .slider.active {   background: #c9cdc280; }test/flakyVercel prod · open 58mSupabase · lockedMonaco · LF · TSLn 1, Col 1Claude✕Codex!✕Gemini✕+codex · test/flaky · 3m · waiting on youFix the flaky order test and make sure the schema matches prod.The test fails because migration 0042 was never applied to prod. I need to read the prod schema and apply it.Access request · Supabase prodScope: read schema, write. No grant on file for this target.Review requestDenyStop · escattachQueue" |
| 7 | Reopen on the Done Cursor card is refused honestly (cursor-agent is not installed) | ok (219 ms) | state paused · banner true |
| 8 | Archive on a Done card removes it from the board | ok (242 ms) |  |
| 9 | + Spawn agent → Codex session from the board, and the ask raises a toast | ok (495 ms) | session 01M340ZKQBNR39RAZTJP5G0ZGW · ask decision · toast "Needs you / Styx · now / Codex needs you / acme-shop · agent/codex-1 / Review / Later" |
| 10 | Later dismisses the toast and is recorded | ok (45 ms) | notification state later |
| 11 | the card is in Needs you and titlebar / badge / inbox all move (or say why not) | ok (88 ms) | card CTA "Review" · needs 3 · badge 3 · inbox 3 |
| 12 | Deny on the needs-you card answers the command approval | ok (57 ms) |  |
| 13 | answer from the Approvals inbox (the README says approving anywhere resolves everywhere) | FAIL (139 ms) | inbox has no row for the spawned session's approval (rows: 3) · out/agents-approvals/09-fail-answer-from-the-approvals-inbox-the-readme-says-approving-anywhere-resolves-everywhere-.png |
| 14 | answer from the chat: Allow resolves the decision, the card returns to Working, counts drop | ok (388 ms) | decision settled=true · session idle · needs 2 · badge 2 |
| 15 | a second ask from the composer: the toast's Review lands in the chat, Deny there resolves it | ok (1817 ms) | toast after resolve: still up · inbox corner 3 |
| 16 | Stop the session → Done; Reopen → running again | ok (197 ms) | state after Reopen working |
| 17 | the inbox lists the three fixture requests with agent · project → target · env · scope | ok (97 ms) |  |
| 18 | Review from the inbox opens the Codex chat with the sheet; Grant 1h · MFA (auto) resolves it | ok (30221 ms) | "grant: supabase-prod · read+write · expires in 1h" · needs 1 · locked 1 · review still enabled: false |
| 19 | the inbox count dropped and the audit log has "granted read+write to Codex · 1h" | ok (132 ms) | now you supabase-prod granted read+write to Codex · 1h |
| 20 | Targets shows Supabase "open · … left"; Revoke locks it and audits the revoke | ok (359 ms) | now you supabase-prod revoked Codex grant · revoked by you |
| 21 | Deny from the inbox on the AWS ask removes the row and audits the denial | ok (151 ms) | now you aws-acme-prod denied read to Claude |
| 22 | "always" on the Cursor → Vercel preview ask shows as persistent | ok (5153 ms) | skipped: fixture row from a done session (prototype content) |
| 23 | the Policies tab and pane read the three builtin rules with their counters | ok (100 ms) |  |
| 24 | + Rule opens an editor to add an auto-approve rule | ok (1230 ms) | rule #4: "Auto-approve deploy on Vercel (Preview) for always" |
| 25 | an auto-approve rule added over IPC appears in the pane | ok (54 ms) | editor's rule shown: Auto-approve deploy on Vercel (Preview) for always matches 0 today Edit Remove |
| 26 | a matching request resolves without asking and the audit says "auto: policy #4" | ok (282 ms) | now system vercel-preview granted deploy to system · always (auto: policy #4) |
| 27 | Settings › Policies (app rail) shows the same rules as the Approvals pane | ok (80 ms) | rows: autoApproveStagingReads, grantIdleExpiry, export |
| 28 | edit (text), toggle from the pane, and delete the rule | ok (309 ms) | policy-changed audit rows so far: 5 |
| 29 | audit rows carry time · actor · target · action, newest first; the fixture rows read as designed | ok (106 ms) | 15 rows · filter/search controls: 0 |
| 30 | open a row → drawer with Actor … Policy rows, Copy JSON and Revoke now; Escape closes it | ok (92 ms) | Revoke now enabled: true (grant is active + user-decided → expected true) |
| 31 | the log is append-only: rows only grow, nothing disappears, the hash chain verifies | ok (190 ms) | 15 → 16 rows |
| 32 | the agent dock lists needs-you cards across projects and a card focuses the main window | ok (665 ms) | 8 cards (1 needs-you) · blog-v2, acme-shop, infra-tools, client-x · header "AGENTS" |
| 33 | the Tasks rail tile opens the modeless dialog with its empty state; Escape closes it | ok (739 ms) |  |
| 34 | Tech debt audit (default agent Codex) starts hidden: dialog, Bypass permissions, no card, no tab | ok (159 ms) | task 01M3410XRQQAE2KBT75C2MW0MZ · state idle · mode bypassPermissions |
| 35 | switching the Permissions select reconfigures the running task and the project default | ok (72 ms) |  |
| 36 | the fake's approval shows inside the dialog; switching projects keeps it; Continue in background | ok (169 ms) | titlebar needs-you 2 · badge 2 while the hidden task asks (task asks count as needs-you: yes) |
| 37 | reopen from Tasks, Allow inside the dialog, the report lands | ok (201 ms) |  |
| 38 | after a relaunch the report is still there under Tasks | ok (1347 ms) |  |
| 39 | Run again starts a new audit; Stop task ends it as Stopped; the earlier report stays reachable | ok (2307 ms) | second 01M34111J36JGNZNQBJE252WC0 · retry button "Try again" · entries 1 |
| 40 | Usage: by-agent and by-project rows add up to the session rows, totals agree | ok (136 ms) | agents claude,codex,gemini,cursor · total 10 / 4 / 4.9k / — |
| 41 | Limits: Refresh asks the fake Codex and fills the block | ok (231 ms) | Codex plan team 5 h · 3% used · resets in 193d 7 d · 1% used · resets in 194d now |
| 42 | agents / approvals / usage / task dialog fit at 1100×680 without horizontal overflow | ok (699 ms) | viewport 1100x680 |
| 43 | Usage empty state on a fixture with no sessions | ok (1151 ms) |  |
