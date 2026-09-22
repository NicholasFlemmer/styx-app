# User simulation · repo-publish

Run 2026-09-22T07:06:19.738Z · 37/37 steps passed · 83 s · fixture `demo`, STYX_NOW 1773308580000, fake CLIs on PATH, no STYX_E2E.

## Findings

### 1. [minor] the Changes column shows the fixture counters, not what git sees in the lane

- Repro: open Repo on the demo project and compare a lane row with `git diff --numstat main` + `git status` in its worktree
- Expected: the +added −removed · n files cell is measured from the worktree (Track agent edits is off by default, so nothing rescans the lane)
- Observed: fix/checkout: row "fix/checkout Claude +142 −38 · 3 files #214 draft Commit & push Land Diff" (store +142 −38 · 3 files) vs git 4 files, +22 −0; test/flaky: row "test/flaky Codex waiting on grant — Open PR Land Diff" (store +12 −4 · 1 files) vs git 2 files, +6 −0
- Where: apps/desktop/src/main/services/hunk-service.ts (enabled() gates the rescan) · seed-repos.ts re-points paths but leaves `changes`

### 2. [major] Repo says the demo project is on github.com/acme/shop while its git has no remote

- Repro: boot the demo fixture, open Repo: header + Connect/Reconnect button; then `git remote -v` in <userData>/demo-repos/acme-shop
- Expected: a repo with no remote reads "— · main ↑0 ↓0" and offers Connect to GitHub; the Publish modal shows the no-remote notice
- Observed: header "github.com/acme/shop · main ↑0 ↓2", button data-repo-connect="reconnect", git remotes: (none)
- Where: seed-repos.ts re-points project/worktree rows but not repos.remotes; LaneSyncService.refresh writes only ahead/behind

### 3. [minor] a lane whose folder is gone still reads like a healthy lane

- Repro: Repo › + Worktree, delete the new folder in Finder, click Fetch, then the row
- Expected: the row says the folder is missing (git lists it as prunable) and offers to recreate or archive it
- Observed: row "wt-1 you clean · ↑0 ↓0 — Open PR Land Open", diff head "wt-1 · checkout.ts · +3 −0", toast "", git prunable: true
- Where: LaneSyncService.refresh measures branches, never the folder; repo-data.ts has no missing state

### 4. [polish] Escape on the Publish modal does not hand focus back to the verb that opened it

- Repro: Repo › Commit & push › Escape
- Expected: focus returns to the lane's publish verb (README: Escape returns focus to its invoker)
- Observed: active element: body[data-action=null] "STYXSwitch, spawn, deploy, grant…⌘K02 needs you02 lockedASBLINCXSA+acme-shopBranch fix/checkoutWorkspaceAgents3Repo3 wtTargetsAgent defaultsEnv & secretsTech debt audit/var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-e2e-Yopeis/demo-repos/acme-shop3 grants activeWorktrees/var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-sim-repo-j3RAG9/origin-2 · main ↑0 ↓0ReconnectTech debt auditFetch+ WorktreeBranchOwnerChangesPRActionsmainyouclean · ↑0 ↓0—Commit & pushOpenfix/checkoutClaudeclean · ↑0 ↓0#7 openCommit & pushLandDifftest/flakyCodexwaiting on grant—Open PRLandDifffix/checkout · checkout.ts · +3 −0@@ -1,7 +1,10 @@ import { sum } from './cart'+import { validate } from './validate'  export async function checkout(cart) {+  validate(cart)   const total = sum(cart.items)   const receipt = await pay(total)+  audit(receipt)   return receipt }"
- Where: ui-store pushOverlay/popOverlay invoker handling for the Repo lane buttons

### 5. [minor] the demo's Claude lane cannot bring main in: its session is "working" with no process behind it

- Repro: demo fixture › Repo › fix/checkout › ↓N main
- Expected: a seeded session with no live process should not count as mid-turn, or the row should say why the click will not work before it is clicked
- Observed: session working, toast "invalid-input Styx · now Claude Code is mid-turn. Wait for it to finish, or stop it, before bringing in main."
- Where: lane-sync-service.ts sync(): live.state === "working" · session rows seeded working without a runner

### 6. [minor] overlaps appear only after Fetch when Track agent edits is off

- Repro: spawn two Codex sessions that each write same.txt on their own lanes; look at Repo
- Expected: the rows read "overlaps <branch>" once both agents have written the file (ADR-0025: after every hunk rescan)
- Observed: tags only after Fetch; chat lines: 1/1
- Where: lane-ledger-service.ts laneChanged is fed by HunkService.onRescanned, gated by trackAgentEdits=false; refreshProject runs on Fetch

## Steps

| # | Step | Result | Note |
| --- | --- | --- | --- |
| 1 | Repo opens with main and the three demo lanes | ok (2147 ms) | main: main you clean · ↑0 ↓2 — Commit & push Open \|\| fix/checkout: fix/checkout Claude +142 −38 · 3 files #214 draft Commit & push Land Diff \|\| test/flaky: test/flaky Codex waiting on grant — Open PR Land Diff \|\| feat/promo: feat/promo Cursor merged yesterday #212 ✓ Archive |
| 2 | the changes column agrees with git for each lane | ok (100 ms) | store vs git disagree: fix/checkout: row "fix/checkout Claude +142 −38 · 3 files #214 draft Commit & push Land Diff" (store +142 −38 · 3 files) vs git 4 files, +22 −0; test/flaky: row "test/flaky Codex waiting on grant — Open PR Land Diff" (store +12 −4 · 1 files) vs git 2 files, +6 −0 |
| 3 | verbs and PR cells read as the copy defines them | ok (19 ms) | fix/checkout: Commit & push (seeded PR #214 draft) — the brief expected Open PR; that is the fixture, not the app |
| 4 | clicking a lane shows its diff below | ok (372 ms) | test/flaky · orders.test.ts · +6 −0 |
| 5 | the header names the remote and the connect verb matches git | ok (21 ms) | MISMATCH header "github.com/acme/shop · main ↑0 ↓2" / reconnect vs git remotes "(none)" |
| 6 | Fetch runs without a remote and leaves the header sane | ok (1527 ms) | header "— · main ↑0 ↓0" |
| 7 | + Worktree adds a lane on disk and in the table | ok (408 ms) | wt-1 at /var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-e2e-Yopeis/demo-repos/.styx/worktrees/acme-shop/wt-1 · row: wt-1 you clean · ↑0 ↓0 — Open PR Land Open (the brief expected agent/…; + Worktree makes wt-<n>, Spawn makes agent/<name>-<n>) |
| 8 | Archive on a merged lane removes the row and the folder | ok (374 ms) | folder gone; branch kept: 17c7a30 |
| 9 | a lane whose folder was deleted by hand: how the row reads | ok (2933 ms) | row "wt-1 you clean · ↑0 ↓0 — Open PR Land Open" · git prunable: true |
| 10 | Publish on a lane with no remote: commit-only and a Connect offer | ok (98 ms) | notice: "This project has no remote yet, so Publish can only commit until one is connected. Connect to GitHub" · chips Commit only=on/true, Commit & push=off/false, Commit, push & open PR=off/false |
| 11 | Connect (existing repo, a bare path) sets origin and brings Publish back | ok (473 ms) | origin=/var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-sim-repo-j3RAG9/origin-1.git · header "/var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-sim-repo-j3RAG9/origin-1 · main ↑0 ↓0" · button reconnect · default kind create (GitHub target connected → hint hidden) · Publish returned: true |
| 12 | Reconnect replaces origin with the second bare path | ok (448 ms) | cta "Reconnect" · origin=/var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-sim-repo-j3RAG9/origin-2.git · feed: you · acme-shop · connected to /var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-sim-repo-j3RAG9/origin-2.git \| you · acme-shop · connected to /var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-sim-repo-j3RAG9/origin-1.git |
| 13 | Publish fix/checkout through Open PR: drafted, editable, then commit · push · PR #7 | ok (1208 ms) | verb "Commit & push" · drafting shown: false · Committed 0da2c46 / main not brought in (Claude Code is mid-turn. Wait for it to finish, or stop it, before bringing in main.) · Pushed fix/checkout / Opened PR #7 · Open PR #7 · row "fix/checkout Claude clean · ↑0 ↓0 #7 open Commit & push Land Diff" |
| 14 | Publish again with nothing to commit | ok (698 ms) | verb "Commit & push" · draft done "Cover order retries in the flaky test  E" · Nothing to commit: the worktree is clean. / main not brought in (Claude Code is mid-turn. Wait for it to finish, or stop it, before bringing in main.) · Pushed fix/checkout |
| 15 | Commit only: the lane commits, the bare stays behind | ok (808 ms) | Committed 12945a0 · push line shown: false · lane HEAD 12945a0 vs bare 0da2c46 · subject "Cover order retries in the flaky test" · draft "Cover order retries in the flaky test" |
| 16 | Home feed has a row per Publish step | ok (23 ms) | 4 rows: you · acme-shop · published fix/checkout (commit 12945a0) \| you · acme-shop · published fix/checkout (PR #7) \| you · acme-shop · published fix/checkout (push) \| you · acme-shop · published fix/checkout (commit 0da2c46) |
| 17 | Publish on main: push only, PR chip off | ok (742 ms) | default chip "Commit & push" · Nothing to commit: the worktree is clean. / Pushed main · PR step shown: false · upstream origin/main |
| 18 | Escape closes the Publish modal and returns focus to its verb | ok (21 ms) | focus after Escape: body[data-action=null] "STYXSwitch, spawn, deploy, grant…⌘K02 needs you02 lockedASBLINCXSA+acme-shopBranch fix/checkoutWorkspaceAgents3Repo3 wtTargetsAgent defaultsEnv & secretsTech debt audit/var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-e2e-Yopeis/demo-repos/acme-shop3 grants activeWorktrees/var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-sim-repo-j3RAG9/origin-2 · main ↑0 ↓0ReconnectTech debt auditFetch+ WorktreeBranchOwnerChangesPRActionsmainyouclean · ↑0 ↓0—Commit & pushOpenfix/checkoutClaudeclean · ↑0 ↓0#7 openCommit & pushLandDifftest/flakyCodexwaiting on grant—Open PRLandDifffix/checkout · checkout.ts · +3 −0@@ -1,7 +1,10 @@ import { sum } from './cart'+import { validate } from './validate'  export async function checkout(cart) {+  validate(cart)   const total = sum(cart.items)   const receipt = await pay(total)+  audit(receipt)   return receipt }" |
| 19 | Land on test/flaky while its agent is waiting on you | ok (870 ms) | refused (session needs-you): Not landed: Codex is waiting on you on test/flaky; answer it (or stop it) before landing. |
| 20 | spawn Codex on a fresh lane and let it write a file | ok (553 ms) | lane agent/codex-1 at /var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-e2e-Yopeis/demo-repos/.styx/worktrees/acme-shop/agent-codex-1 · row "agent/codex-1 Codex clean · ↑0 ↓0 — Open PR Land Diff" |
| 21 | Land agent/codex-1: modal, summary, steps, merge commit on main, pushed | ok (1226 ms) | committed bf91262 merged into main (c48a3e9) pushed main agent/codex-1 is now in main and on origin. · row "agent/codex-1 Codex landed today — Undo landing" · chat "Your work on agent/codex-1 is now in main and on origin. Undo is on the Repo lane until main moves on; after that the lane is tidied away by itself." · home "you · acme-shop · landed agent/codex-1 into main" |
| 22 | Undo landing reverts on main, pushes, and the lane is live again | ok (446 ms) | main "Revert "Add landed.txt from the codex lane"" pushed · row "agent/codex-1 Codex clean · ↑0 ↓0 — Open PR Land Diff" · chat 1 · home 1 |
| 23 | Land again right after Undo | ok (807 ms) | re-landed: reapplied the undone landing on main (f4b9e42) pushed main agent/codex-1 is now in main and on origin. |
| 24 | a fresh lane with nothing to land refuses honestly | ok (6775 ms) | facts "0 files changed Then main is pushed to origin." · draft done · Land enabled · "Not landed: Nothing to land: wt-2 has no changes main does not already have." |
| 25 | review mode swaps Land for Merge into main and keeps Open PR | ok (668 ms) | Merge into main + Open PR in review; Land back in auto |
| 26 | origin moves → Fetch fast-forwards main and the lane rows show ↓N main | ok (9467 ms) | row "fix/checkout Claude clean · ↑0 ↓0 ↓5 main #7 open Commit & push Land Diff" · header "/var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-sim-repo-j3RAG9/origin-2 · main ↑0 ↓1" · chat "main moved: 1 new commits. Bring them in from Repo before you publish." |
| 27 | the Workspace status bar shows the same ↓N main for the editor's lane | ok (251 ms) | fix/checkout Vercel prod · open 58m Supabase · locked ↓5 main Monaco · LF · TS |
| 28 | Bring in main on fix/checkout (its agent reads as working) | ok (2594 ms) | refused: "invalid-input Styx · now Claude Code is mid-turn. Wait for it to finish, or stop it, before bringing in main." |
| 29 | Bring in main on the codex lane merges and clears the count | ok (9295 ms) | row "agent/codex-4 Codex +2 −0 · 2 files — Open PR Land Diff" · lane HEAD "Merge branch 'main' into agent/codex-4" · chat "Brought in main: 1 commits." |
| 30 | dirty main folder: Land refuses with the dirty-base message and moves nothing | ok (2401 ms) | Not landed: The main folder has uncommitted changes on main. Commit or discard them first. |
| 31 | diverged main: Land refuses with the diverged message; nothing moved | ok (9212 ms) | /var/folders/lf/9y62j4_x7vl4t5wmnymvzx5h0000gn/T/styx-sim-repo-j3RAG9/origin-2 · main ↑1 ↓1 · Not landed: main on this machine and origin/main have each moved on (1 local, 1 remote). Bring origin/main into main in the main folder first, then land again. |
| 32 | two lanes touching the same file: overlaps tag on both rows, a line in each chat | ok (8919 ms) | tags only after Fetch · "agent/codex-2 Codex +1 −0 · 1 file overlaps agent/codex-3 — Open PR Land Diff" · chat "Codex on agent/codex-3 also changed same.txt — their task: "write same.txt". Keep to your own files, or agree who does what with send_message." |
| 33 | lane rows fit at 1100×680 | ok (856 ms) | no cell overflows |
| 34 | error fixture: the lane reads CONFLICT and its session is paused with the banner | ok (2170 ms) | row "fix/checkout Claude CONFLICT · checkout.ts vs main #214 draft Resolve" · session paused/conflict · banner "fix/checkout conflicts with main in checkout.ts. Claude is paused until resolved. Resolve" |
| 35 | Resolve hands the merge to the lane's agent: what the state reads | ok (4207 ms) | row "fix/checkout Claude merging main with Claude… #214 draft Stop merging" · toast "" · resolution {"state":"resolving","sessionId":"01JDEMOSESS000000000000001","files":["checkout.ts"],"preHead":"ec93493478faf1f9e7911112fce50ed9bb83b9b8","preTree":null,"mergeCommit":null,"attempts":1,"startedAt":1773308580000,"finishedAt":null,"failure":null} · session working/null · merge in progress: true · dirty 3→1 · HEAD ca9eceb→ec93493 · chat: main conflicts with this lane in checkout.ts. Claude Code is bringing it in now — both sides kept; the checks run before it counts. \| Styx is bringing main into this lane (fix/checkout) and the merge stopped on conflicts. The merge is in progress in your worktree (MERGE_HEAD is set). Resolve it in place: do not abort, rebase, or commit it — Styx commits it once the checks pass.  Conflicted files: - checkout.ts   yours (fix/checkout, "Add input validation to checkout and cover it with tests."): Work on fix/checkout before bringing in main; fix/checkout: changes   theirs (main): main: move cart module  Rules: keep both sides' behaviour — this lane's change and what main brings — unless they genuinely contradict, in which case keep both where possible and say in one line what you dropped and why. Never drop the other side's work. Append-only documents (changelogs, numbered tables, migration lists) are appended after the other side's entries and renumbered, never overwritten. Touch only the conflicted files and what they force you to touch. Remove every conflict marker. Then work out how this project checks itself (typecheck, tests, lint — read its package scripts), call the styx `remember_command` tool with kind "checks" and the exact command so Styx can run it from now on, and run it — it must pass.  When the merge is finished, say so in one line. |
| 36 | the fake agent cannot finish: does the lane get stuck, and does Undo merge leave the tree clean | ok (8238 ms) | row "fix/checkout Claude merging main with Claude… #214 draft Stop merging" · resolution resolving · session working/null · merge in progress: true → worktree.undoResolve → ok → row "fix/checkout Claude CONFLICT · checkout.ts vs main #214 draft Resolve" · merge in progress: false · markers in checkout.ts: false · status: clean |
| 37 | Bring in main on the conflicting lane (auto mode) goes to the resolver, not a silent abort | ok (4 ms) | no ↓N main on the row: "fix/checkout Claude CONFLICT · checkout.ts vs main #214 draft Resolve" |
