<div align="center">

<img src="apps/desktop/build/icon.png" alt="Styx" width="88" height="88" />

<h1>Styx</h1>

**Run Claude Code, Codex, Gemini and Cursor on all your projects at once.<br />They ask before they touch production.**

[**Download for Mac**](https://heystyx.com/download/mac?from=github) &nbsp;·&nbsp; [**Download for Windows**](https://heystyx.com/download/win?from=github) &nbsp;·&nbsp; [Website](https://heystyx.com) &nbsp;·&nbsp; [Watch the story (1:42)](https://heystyx.com/story)

[![CI](https://img.shields.io/github/actions/workflow/status/NicholasFlemmer/styx-app/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/NicholasFlemmer/styx-app/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-d6ff3d?style=flat-square&labelColor=0d0e0c)](LICENSE)
![macOS · Windows](https://img.shields.io/badge/macOS%20%C2%B7%20Windows-free-d6ff3d?style=flat-square&labelColor=0d0e0c)

<br />

<img src=".github/assets/readme-hero.gif" alt="A Codex task asks for write access to the production Supabase database; you review the request and grant it for an hour, and the task carries on" width="900" />

</div>

<br />

You already use coding agents. The hard part is everything around them: one agent per terminal, each on whatever
branch it found, your deploy keys sitting in a `.env` they can all read, and no idea which one is waiting on you.

Styx is one window for all of it. Every project you work on, every agent working in them, and every login they need
to ship. Each task gets its own branch, so agents never trip over each other. And when one wants to deploy, migrate a
database or touch anything live, it has to ask you first.

## Get started

1. **[Download Styx](https://heystyx.com)** for Mac (Apple Silicon) or Windows. It's free.
2. **Add a project.** Styx finds the repos you already have, along with your editor's recent projects.
3. **Start a task.** Say what you want and pick the agent. It works on its own branch, and you land the result on
   main when you're happy.

Styx drives the agent CLIs you already have and are signed in to (Claude Code, Codex, Gemini CLI or Cursor), so your
existing subscriptions just work. There are no API keys to paste, and your prompts go straight to the agent, not
through us.

## What it does

### Many tasks, side by side

<img src=".github/assets/readme-tasks.jpg" alt="Tasks: five tasks side by side, two waiting on you, with the chat for the one you're looking at" width="900" />

Every task runs in its own copy of the repo on its own branch. Tasks shows them all at once: what each is doing,
what it changed, and which ones are waiting on you. When one is done, **Land** commits it, brings main in, runs your
checks and merges it. If a turn went wrong, **Undo this turn** puts the files back the way they were.

### Agents ask before production

<img src="apps/website/public/launch/access-request.jpg" alt="An access request: Codex asks to write to the production Supabase database for one hour" width="360" align="right" />

Connect Vercel, AWS, Google Cloud, Supabase, GitHub and SSH once. From then on an agent can't just use them: it asks,
says why, and you choose what it gets and for how long (once, an hour, or the session).

- **Scoped and short-lived.** Agents get a token or an SSH agent socket for that grant only, and it's revoked when
  the grant ends. They never see your keys.
- **Production needs you physically there.** Deploys, writes and deletes on production ask for Touch ID or Windows
  Hello.
- **Your keys stay in your keychain.** Never in the project, the database, the logs or the agent's environment.
- **Everything is written down.** Every request, approval, use and revoke goes into an audit log that can't be
  edited after the fact.

<br clear="right" />

### Design it before you build it

<img src=".github/assets/readme-design.jpg" alt="The Design canvas: a checkout screen at desktop, tablet and phone sizes, with an element selected and a message to Codex" width="900" />

Ask an agent for screens and they appear on a canvas at desktop, tablet and phone sizes. Click anything to change it
yourself or tell the agent what to fix. When it looks right, **Build it** starts a build task with the design attached.

### Point at what's wrong

<img src="apps/website/public/app/preview.jpg" alt="Preview: the running app with the Pay button selected and a note for Claude" width="900" />

**Preview** runs your app inside Styx. Use **Select to fix**, click the thing that's off and say what's wrong: the agent
gets the element, the page and a picture of it.

## Works with

- **Agents:** Claude Code · Codex · Gemini CLI · Cursor agent · any shell
- **Targets agents can ask for:** Vercel · AWS · Google Cloud · Supabase · GitHub · SSH
- **Platforms:** macOS (Apple Silicon) · Windows
- **Editors:** the built-in editor and terminal, or open any task in VS Code, Cursor, Zed or JetBrains

## Free, open, and private

**Is it free?** Yes. Styx is free and open source under the [Apache License 2.0](LICENSE). Every feature works without
an account. Signing in (with GitHub or Google) is optional.

**What leaves my machine?** Your code, projects, paths and prompts never do. Release builds send anonymous usage counts
(how often the app opens, a task starts, an agent fails to start and why) so we know what to fix. The complete, fixed
list is [`usageEventSchema`](packages/core/src/model/usage-report.ts), with no field that could carry a name, path or
text. Turn it off in **Settings › Styx account**. Builds you make from source never send anything.

**How does an agent ask?** Agents talk to Styx through a local broker (`styx mcp`) and small wrappers around the
`gh`, `vercel`, `aws`, `gcloud`, `supabase` and `ssh` commands. A request shows up in the chat, on the task and as a
notification, and approving it anywhere resolves it everywhere. The design decisions behind this are in
[`docs/adr`](docs/adr).

<details>
<summary><b>Build from source</b></summary>

<br />

You need Node 22 or newer, pnpm 10 (`corepack enable` picks the right version) and git. On macOS, the Xcode command line
tools; on Windows, the Visual Studio C++ build tools (for the native modules).

```sh
pnpm install
pnpm tokens:build
pnpm dev                       # STYX_FIXTURE=demo seeds sample projects in a temporary database
```

Checks and packaging:

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm e2e                       # Playwright, driving the Electron app
pnpm storybook                 # the component library
pnpm package:mac               # or package:win
```

The code is a pnpm monorepo:

| Path              | What                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `apps/desktop`    | The Electron app: `src/main` (database, git, terminals, keychain, the access broker) and `src/renderer` (React) |
| `apps/website`    | [heystyx.com](https://heystyx.com)                                                                              |
| `packages/core`   | Domain types, state machines, the policy engine and the IPC contract. No Electron, DOM or I/O                   |
| `packages/ui`     | The component library, with Storybook                                                                           |
| `packages/broker` | The protocol agents use to ask for access, and `styx mcp`                                                       |
| `packages/cli`    | The `styx` command line and the provider wrappers                                                               |

If Electron starts as plain Node, your shell has `ELECTRON_RUN_AS_NODE` set; the scripts above already clear it.

</details>

## Contributing

Bug reports, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). To report a security
problem, please follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## License

Apache License 2.0. See [LICENSE](LICENSE). The Styx name and logo aren't covered by the licence, so if you ship a fork,
give it its own name.
