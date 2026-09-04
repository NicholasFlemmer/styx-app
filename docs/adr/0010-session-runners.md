# ADR-0010 Session runners: `stream` for Claude Code and cursor-agent, `pty` for the rest

Status: proposed · 2026-09-04 (confirm in Phase 7 spike)
`stream` = headless bidirectional stream-json (`claude -p --input-format stream-json --output-format stream-json`, `cursor-agent --print --output-format stream-json`) giving a structured transcript. `pty` = TUI in xterm with Styx cards rendered above the composer. `sessions.runner` column records the choice.
