# Handoff: Styx — project, agent and repo switcher (desktop)

## Overview
Styx is a local desktop app (macOS + Windows, Electron + React) that lets a developer switch between projects in one window, work in an embedded editor (Monaco) alongside coding-agent chat sessions (Claude Code, Codex, Gemini CLI, Cursor agent, shell), and gate agents' access to deploy/server targets (Vercel, AWS, GCP, Supabase, GitHub, SSH) through scoped, expiring grants with an audit log.

## About the design files
Files in this bundle are **design references created in HTML**. They show intended look and behavior; they are not production code. The task is to **recreate these designs in the app's React codebase** using its established patterns. If none exists yet, use Electron + React + TypeScript, Monaco for the editor pane, xterm.js for the terminal, and node-pty for agent CLIs.

## Fidelity
**High-fidelity.** Colors, typography, spacing, copy and interaction states in `Styx.dc.html` are final for v1. Recreate pixel-accurately. The wireframes (`Wireframes.dc.html`) are lo-fi history only.

## Start here
1. `Styx Spec.dc.html` — the written specification (object model, state machines, tokens, layout, every screen and flow, keyboard map, platform differences, component inventory, accessibility, copy). Open in a browser; also printable.
2. `Styx.dc.html` — the interactive prototype. Top strip switches screens, theme and mac/Windows chrome; second strip toggles flows and states (onboarding, diff review, connect target, spawn agent, empty, errors, notification, pop-out, audit detail). ⌘/Ctrl+K opens the palette. In the workspace, click the Codex tab → Review request → Grant to see the grant flow propagate through board, approvals, audit, targets and counters.
3. `styx-tokens.json` / `styx-tokens.css` — design tokens. Use the CSS variables verbatim; theme is a `data-theme` attribute on `<html>`.
4. `UX Research Memo.dc.html` — rationale: personas, analogues, principles, editor-route decision (Monaco now, VS Code as fallback via "Open in…").

## Screens / views (all in Styx.dc.html; details in the spec §4)
- Workspace — files 200px · Monaco editor with agent hunks + hunk bar · terminal 130px · status bar 26px · chat pane 360px with session tabs, transcript, composer; grant sheet 360px slides over the chat.
- Home (All projects) — 4 counters (56px numerals), project table, add row, activity feed; empty state.
- Agents board — Needs you / Working / Done columns, cards with actions, spawn button; empty texts.
- Repo (Worktrees) — lane table (branch, owner, changes, PR, action), selected-lane diff; conflict state.
- Approvals — Inbox / Policies / Audit log tabs, policies pane 380px, audit entry drawer 380px.
- Settings — App vs Project nav 220px; Targets table; label/value rows.
- Diff review — per-hunk accept/reject with keyboard keys, files list, done.
- Onboarding — 4 steps: Editor (detect IDEs, import recents/keybindings/theme, set fallback) → Projects (scan + IDE recents) → Agents (detected CLIs + auth) → Targets (provider grid → connect modal).
- Connect target modal — provider grid → OAuth / IAM-key / SSH forms with environment chips.
- New project modal — greenfield: name, location, start from (empty / template / agent scaffolds it with a brief), git init, create GitHub repo, copy targets, open in IDE; reachable from rail +, Home, onboarding, palette.
- Spawn agent modal — agent tiles, worktree/branch, first message, toggles; CLI-missing inline error.
- Pop-out chat window — 400×500 separate OS window with platform chrome and Dock button.
- Notifications — in-app toast; macOS dock badge; Windows tray + Action Center toast.
- Error banners — auth expired, CLI missing, merge conflict; each with a resolving action.
- Command palette — grouped Actions / Agents / Projects with lock state in meta.

## Interactions & behavior
See spec §1 (state machines), §4 (per screen), §5 (palette), §6 (keyboard). Key rules:
- One agent session = one git worktree by default (branch `agent/<name>-<n>`).
- A grant request pauses the session in `needs-you`; the ask renders inline in chat, on the board, in Approvals inbox, as a toast and as a dock/tray badge. Approving anywhere resolves it everywhere.
- Prod write/deploy/delete requires OS biometric (Touch ID / Windows Hello). Default duration 1h; `always` is opt-in and shown as persistent. Grants expire on idle 1h, session end, or revoke.
- Hover is instant (no transition). Sheet 160ms slide, modals 120ms fade, toast 160ms slide; reduced-motion → fades only.
- Escape closes any overlay and returns focus to its invoker.

## State management
Top-level store: projects[], sessions[], worktrees[], targets[], grants[], auditLog[], policies[], ui { screen, projectId, sessionId, overlays, theme, platform }. Derived: needsYouCount, lockedCount, activeGrants, board columns, palette results. Persist ui.screen/projectId/window positions per machine; project settings in `.styx/project.json` (committed, secrets excluded); secrets only in OS keychain via credentialRef.

## Design tokens
Full list in `styx-tokens.json` and spec §2. Summary (dark / light):
- bg #0d0e0c / #eeefe9 · s1 #121411 / #f7f8f3 · s2 #1c1e1a / #e1e3db · ln #2d302a / #b3b7ab · tx #e9ebe3 / #14160f · mu #858a81 / #5d6259
- accent #d6ff3d / #c6f20f, ink on accent #0d0e0c / #14160f, accent-as-text #d6ff3d / #6e8f00 · diff add rgba(214,255,61,.13) / rgba(150,200,0,.2)
- Fonts: Archivo (400–700) UI, JetBrains Mono (400/500) code. Label 10px 600 .1em uppercase; body 13px; code 12.5px/1.75; numerals 28/56px 600 tabular.
- Space 4px base; radius 0; shadows none; floating surfaces use a 1px text-color border.
- Two selection vocabularies: `data-inv` (inverted = current) and `data-on` (accent = attention/armed).

## Assets
No raster assets. Fonts from Google Fonts (bundle them in the app). Glyphs are Unicode text (▾ ✕ ⤢ ─ ☐ ⏎ ⌘); replace with an icon set of the team's choice at the same sizes if preferred.

## Files
- Styx.dc.html — interactive prototype (all screens, flows, states)
- Styx Spec.dc.html — specification document
- styx-tokens.json, styx-tokens.css — tokens
- UX Research Memo.dc.html — research and rationale
- Wireframes.dc.html — lo-fi exploration (history)
- support.js, doc-page.js — runtime helpers needed to open the .dc.html files locally
