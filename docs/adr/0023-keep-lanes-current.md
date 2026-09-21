# ADR-0023 Keep lanes current: fetch on spawn, behind-base on every lane, merge base before publish

Status: accepted · 2026-09-18 (owner request)

A lane (an agent's worktree) is cut from the project's base branch and then lives for hours or days while the base
moves on. The owner watched the cost of that first-hand: a worktree cut on 11 September was worked on for a week
without syncing; the eventual merge conflicted in eleven files and a package built from the stale branch had to be
thrown away. "You should have rebased main to this worktree first." Agents are worse at remembering to do this than
people are, and when they try they improvise git choreography of their own.

## Decision

Styx owns the lane's relationship with its base. Three moments, each deterministic and visible:

1. **Fresh base on spawn.** Before a lane is cut (`session.spawn` with a new worktree, `worktree.create`), Styx
   fetches when the repo has a remote, so the base tip is as current as the network allows. Project setting
   `syncOnSpawn` (default on).
2. **Drift is visible while the agent works.** Every lane carries `behindBase`: commits on the base branch it has not
   merged in. `worktree.fetch` (the Repo screen's Fetch, and the refresh scheduler on focus / wake / manual) recomputes
   it with `git rev-list --left-right --count <lane>...<base>`, alongside the existing conflict dry run. The Repo lane
   shows `↓3 main` after its changes and the click brings the base in; the Workspace status bar shows the same for the
   worktree in the editor; the owning session's chat gets one system line when the base moves ("main moved: 3 new
   commits…"). `LaneSyncService` (main) does all of it; the renderer only renders.
3. **The exit is gated.** `worktree.sync` merges the base into the lane (`git merge --no-edit <base>` in the
   worktree). Publish runs it between commit and push when `syncBeforePublish` is on (default), so what leaves the
   machine merges cleanly; the push line reports "Brought in N commits from main". A conflict is undone on the spot
   (`git merge --abort`), the lane is marked with the existing conflict state, the owning session pauses exactly as a
   detected conflict pauses it today, and Publish stops with the file named.

Sync refuses while the owning agent is `working`: it may be writing files, and a merge underneath it would be worse
than a stale lane. The agent is told the arrangement in its system prompt (`agentPrompt.lane`): the lane's branch and
base, that Styx keeps it current, and not to rebase, merge or switch branches itself.

## Why merge, not rebase

Rebase rewrites the lane's history. Turn checkpoints (ADR-0020) are hidden refs pointing at that history, the agent's
own session may hold commit ids in its context, and a rebase under a paused agent invalidates both. A merge commit
keeps every existing ref valid and makes the sync itself visible in the lane's log.

## Consequences

- `worktrees.behind_base` (migration 0017); `Worktree.behindBase` in core; `worktree.sync` command;
  `worktree.publish` output gains an optional `synced`.
- The base is `ProjectSettings.baseBranch` (default `main`), the same setting Publish already uses for PRs.
- "Resolve with agent" is ADR-0025 phase B.
- **The local base follows its upstream (closed 2026-09-21).** A fetch updates `origin/main`, never `main`, and
  every count, "already up to date" line, sync and landing was measured against the local branch — on one project
  77 commits behind GitHub, so a lane heard "Already up to date with main" while main had moved on for a week.
  `LaneSyncService.freshenBase` runs after every fetch (refresh, sync, turn-end auto sync, landing): a
  fast-forward is the only move it makes — in the main folder when it is on the base and clean, by ref when the
  base is checked out nowhere. A dirty main folder is left alone and lanes measure against and merge from the
  upstream ref (`baseRefOf`) until it is clean; a diverged base (local commits the upstream lacks) is never
  touched, the Repo row's ↑/↓ shows it, and a landing refuses with `land.baseDiverged` rather than merging onto
  a base the remote would reject.
