# Contributing to Styx

Thanks for helping. This page covers how to report a problem, how to get a change merged, and the few rules
the codebase holds to.

## Reporting a bug or asking for something

Open an issue with what you did, what you expected and what happened instead. Include your OS, the Styx
version and which agent CLIs you use. Screenshots help a lot for anything visual.

Security problems are different: please don't open a public issue. See [SECURITY.md](SECURITY.md).

## The easiest ways in

Two kinds of contribution are self-contained: you don't need to understand the whole app, and each has a guide with a
worked example and a checklist of every place to change.

- **[Add an agent](docs/contributing/adding-an-agent.md)**: support another coding agent CLI.
- **[Add a deploy target](docs/contributing/adding-a-target.md)**: let agents ask for access to another platform.

## Making a change

1. For anything bigger than a small fix, open an issue first so we can agree on the approach before you spend
   time on it.
2. Fork, branch, and set up as in the [README](README.md#build-from-source).
3. Make the change with its tests (see below).
4. Before you push, run:

   ```sh
   pnpm typecheck && pnpm lint && pnpm test
   ```

   For UI changes, also run `pnpm e2e` and `pnpm visual`, and add or update the Storybook story.

5. Open a pull request saying what changed and why. CI runs the same checks.

By submitting a contribution you agree it is licensed under the [Apache License 2.0](LICENSE), as section 5 of
the licence describes. There is no separate contributor agreement to sign.

## How the codebase works

[CLAUDE.md](CLAUDE.md) is the full set of conventions (it is written for coding agents, and it applies to people
too). The ones that matter most:

- **The main process owns all state.** The renderer shows a read-only copy and never touches the file system,
  git, child processes, the network or secrets. Every change goes through a named command defined in
  `packages/core/src/ipc/contract.ts`.
- **Logic lives in `packages/core`,** not in React components or IPC handlers. State machines and the policy
  engine are pure functions with table-driven tests and full branch coverage.
- **Secrets only ever live in the OS keychain.** Never in SQLite, logs, IPC payloads, renderer state, fixtures or
  the repo. The audit log is append-only.
- **The design is the spec.** `design/handoff/` decides look, spacing and copy. Use the design tokens (no raw
  colours or sizes), keep corners square, and take user-facing text from `packages/core/src/copy.ts`.
- **TypeScript is strict:** no `any`, zod at every boundary, named exports, `kebab-case.ts` files,
  `PascalCase.tsx` components with a CSS Module, a story and a test next to them.

Tests sit next to the code they test. Run one package with `pnpm -F @styx/core test` (or `@styx/desktop`,
`@styx/ui`). The demo data (`STYX_FIXTURE=demo pnpm dev`) is the quickest way to see a screen with something
on it.

## Shipping your own build

Release builds sign in against, and send anonymous usage counts to, the hosted Styx service. If you publish a
fork, change `DEFAULT_API` in `apps/desktop/src/main/services/account-service.ts` (or set `STYX_API`) to a
service you run, or turn usage reporting off in `apps/desktop/src/main/index.ts`, and give the fork its own
name: the Styx name and logo are not part of the licence.

## Code of conduct

Be kind, assume good intent, and keep discussion about the work. Harassment or personal attacks get you
removed from the project.
