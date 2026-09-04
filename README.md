# Styx

Project, agent and repo switcher for the desktop (macOS + Windows). Switch projects in one window, work in an
embedded editor beside coding-agent sessions (Claude Code, Codex, Gemini CLI, Cursor agent, shell), and gate
agents' access to deploy/server targets through scoped, expiring grants with an audit log.

- Design handoff (authoritative): `design/handoff/`
- Plan and decisions: `docs/plan.md`, `docs/adr/`
- Roadmap and state: `.planning/`

## Develop

```sh
pnpm install
pnpm tokens:build
pnpm dev                       # STYX_FIXTURE=demo seeds a temp database
pnpm test && pnpm typecheck && pnpm lint
pnpm e2e                       # Playwright Electron
pnpm visual                    # screenshots vs prototype baselines
pnpm storybook
```

If Electron starts as plain Node (`electron.app` undefined), your shell has `ELECTRON_RUN_AS_NODE` set; the scripts
above already strip it.
