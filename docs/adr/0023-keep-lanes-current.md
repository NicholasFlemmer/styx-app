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
- Not done yet: "Resolve with agent" (handing a conflicting sync to the owning agent as a turn) and keeping the
  local base branch itself current with its upstream. Both fit the same service; the conflict path today ends in
  the existing Resolve lane action.
