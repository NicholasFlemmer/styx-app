# Styx

Every project. Every agent. Every key. One window.

Styx is a desktop app for people who run AI coding agents (Claude Code, Codex, Gemini CLI, Cursor) across more
than one project. Every repo you work in, the agents building in them and the logins they need to ship sit in
one window, and you switch between all of it without hunting for the right terminal.

Agents never get your keys for free. When one needs to deploy, or touch live data, it asks first: you see the
request, approve it for an hour or a session, and every request, approval and use is written to an audit log
you can't edit.

Download it for macOS or Windows at [heystyx.com](https://heystyx.com).

## What it does

- **One window for every project.** Switch projects from the rail; each keeps its editor, terminal and agents.
- **Agents side by side.** Each agent works on its own branch in its own copy of the repo, so two agents never
  edit the same files. When one is done, you review the change and land it on main.
- **Ask before production.** Vercel, AWS, Google Cloud, Supabase, GitHub and SSH targets are connected once.
  Agents get short-lived, scoped access only after you approve, and production deploys or deletes ask for
  Touch ID or Windows Hello.
- **Your secrets stay in your keychain.** Credentials live in the operating system's keychain, never in the
  project, the database or the logs.

## Your data

Styx runs on your machine. Your code, projects, paths and prompts never leave it.

Signing in (with GitHub or Google) is optional and everything works without it.

Release builds send **usage counts** so we know which features get used and where people get stuck: how often
the app is opened, a project added, an agent started or fails to start (and why: not installed, not signed in, out
of quota), an access request approved, a deploy run, a branch landed, the app crashed, and the like. The full,
fixed list is `usageEventSchema` in [`packages/core/src/model/usage-report.ts`](packages/core/src/model/usage-report.ts):
each is a name and a count, with no field for names, paths or text, sent with a random install id, the app
version and the operating system (and your account, if you are signed in). Counts are deleted after 180 days.
Turn them off in **Settings › Styx account › Send usage counts**. Builds you make from source never send them.

## Build from source

You need Node 22 or newer, pnpm 10 (`corepack enable` picks the right version) and git. On macOS you also need
the Xcode command line tools; on Windows, the Visual Studio C++ build tools (for the native modules).

```sh
pnpm install
pnpm tokens:build
pnpm dev                       # STYX_FIXTURE=demo seeds a temporary database with sample projects
```

Checks and packaging:

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm e2e                       # Playwright, driving the Electron app
pnpm visual                    # screenshots against the design prototype
pnpm storybook                 # the component library
pnpm -F @styx/desktop package:mac:dir && pnpm -F @styx/desktop package:smoke   # unsigned .app + boot check
pnpm package:mac               # signed + notarized (needs a Developer ID)
pnpm package:win
```

If Electron starts as plain Node (`electron.app` is undefined), your shell has `ELECTRON_RUN_AS_NODE` set; the
scripts above already strip it. If a native module fails to load after an Electron upgrade, run
`pnpm rebuild:native`.

## How the code is laid out

A pnpm monorepo:

| Path              | What                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apps/desktop`    | The Electron app: `src/main` (database, git, terminals, keychain, the access broker), `src/preload`, `src/renderer` (React 19) |
| `apps/website`    | heystyx.com (Next.js, static export)                                                                                           |
| `packages/core`   | Domain types, state machines, the policy engine and the IPC contract. No Electron, DOM or I/O                                  |
| `packages/ui`     | The component library, with Storybook                                                                                          |
| `packages/tokens` | Design tokens and bundled fonts                                                                                                |
| `packages/broker` | The protocol agents use to ask for access, and `styx mcp`                                                                      |
| `packages/cli`    | The `styx` command line and the provider shims                                                                                 |

The design in `design/handoff/` is the spec for how the app looks and behaves. Decisions and their reasons are
in `docs/adr/`.

## Contributing

Bug reports, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). To report a
security problem, follow [SECURITY.md](SECURITY.md) rather than opening a public issue.

## Licence

Styx is licensed under the [Apache License 2.0](LICENSE). The name "Styx" and the Styx logo are not covered by
the licence: if you ship a fork, give it its own name.
