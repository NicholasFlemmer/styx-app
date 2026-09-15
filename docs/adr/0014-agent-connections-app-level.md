# ADR-0014 Agent connections are app-level and verified through each CLI's own status command

Status: accepted · 2026-09-15

An agent CLI (Claude Code, Codex, Gemini CLI, Cursor agent) is connected once for the whole app, on Settings ›
App › Agents, and every project spawns sessions from that connection — the same shape as targets, which are
connected once and granted per session. Styx never holds the CLI's credential: verification asks the CLI who it is
signed in as (`claude auth status --json`, `codex login status`, `agent status`; Gemini's account file, since it has
no status command) and stores only the whitelisted answer (`account`, `verifiedAt`, `verifyError`) on the
`cli_installs` row. Sign-in runs the CLI's own login in a pty the renderer attaches to, exactly as provider CLIs
do for targets, and re-verifies when it exits. The Spawn modal, onboarding step 3 and the cli-missing banner all
open the same Connect agent modal, so a wrong first attempt is fixed in one place before a session is spawned.

Rejected: keeping the filesystem auth heuristic as the only signal (it cannot say *who* is signed in and is wrong
for API-key setups), and a per-project connection (the CLI's login is per machine, so per-project rows would only
duplicate state).
