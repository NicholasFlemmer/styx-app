# ADR-0020 Turn checkpoints: every agent turn as hidden git refs, diffable and revertible

Status: accepted · 2026-09-17 (owner request, modelled on t3code)

An agent turn can touch many files, and the hunk review (ADR-0015) works one hunk at a time against the
worktree as it is now. The owner asked for what t3code does: every turn's workspace state captured so a turn can
be diffed as a whole and _reverted_ — "restore the worktree to the state before that turn (and therefore undo
later turns too)" — with nothing landing on the user's branch.

## Decision

**Model.** `Checkpoint` (`packages/core/src/model/checkpoint.ts`, table `checkpoints`, migration 0015): one row
per turn of a session — `turn` (1-based), `messageId` (the user row that started it), `baseRef` (the tree before
the turn), `ref` (the tree after it, `null` while the turn runs), numstat `files / added / removed`, `settledAt`,
`revertedAt`. Read-model slice `checkpoints[sessionId]`, delta `checkpoints.replace`.

**Capture.** `CheckpointService` (`apps/desktop/src/main/services/checkpoint-service.ts`) snapshots the worktree
as a commit without touching anything the user owns:

- a temporary index file (`GIT_INDEX_FILE` in `os.tmpdir()`), seeded with `read-tree HEAD` (so a tracked file
  that an ignore rule happens to match stays tracked) then `add -A` — tracked edits, untracked files, deletions,
  ignores honoured; the user's index is never read or written;
- `write-tree` → `commit-tree <tree> -p HEAD -m "styx checkpoint"` with a fixed identity and `commit.gpgsign=false`
  (a signing prompt would hang the capture); HEAD is the parent so `git log`/`diff` between checkpoints read like
  any range, but no branch or tag moves and HEAD stays where it was;
- `update-ref refs/styx/checkpoints/<sessionId>/<turn>/{base,after} <commit>`. Refs under `refs/styx/` are
  outside `refs/heads` and `refs/tags`: `git branch`, `git tag`, `git push` and the GitHub UI never see them
  (`git log --all` does; that is the price of keeping the objects reachable and out of `gc`).

**Turn boundaries.** `SessionService` fires `turnStarted(sessionId, messageId)` right after the user row is
appended (in `sendMessage`, and in `launch` for the first message, which travels with the spawn) and
`turnSettled(sessionId)` when the session goes quiet → idle (stream runners' `session` effect, the Claude `Stop`
hook, Codex `notify`). The service runs each session's operations through a promise chain so a settle never
overlaps the next base capture. `turnStarted` captures `base` and inserts the row (turn = previous max + 1); if
the previous turn never settled (a pty session has no settle signal) it is settled first and its `after` doubles as
the new `base`. `turnSettled` captures `after`, fills the numstat (`diff --numstat --no-renames base after`),
publishes, and appends the `copy.checkpoints.settled` system line when files > 0. Any git failure is logged and
never breaks a turn: the row keeps `ref = null` (or is not created at all when the base capture fails); plain
folders (no git) are skipped.

**Diff.** `checkpoint.diff {checkpointId}` → `git diff base after`; while the turn is still running, `base`
against the live worktree through the same temporary index (`diff --cached`), so untracked files show.

**Revert.** `checkpoint.revert {checkpointId}` is refused with `invalid-transition` while the session is
`working` or `needs-you`. It computes `diff --cached --name-status --no-renames` of the live tree (temp index)
against `base`: paths that are `A` (not in base) are deleted (each one `confine`d to the worktree first), every
other differing path is written back with `git --literal-pathspecs restore --source=<base> --worktree
--no-overlay --pathspec-from-file=-`. Only paths that differ are touched, ignored files are never touched, and
the index and HEAD stay as they are — a staged file the agent added shows up staged-but-deleted afterwards,
which is the honest picture. This turn and every later one get `revertedAt`; the chat gets
`copy.checkpoints.revertDone`; the hunks are re-scanned so the editor's decorations follow the tree.

**Retention.** `prune()` at startup and hourly: refs (`for-each-ref refs/styx/checkpoints/` in each project's
repo, since a linked worktree shares its refs with the main checkout) and rows of sessions that are gone or
archived, or whose worktree no longer exists on disk, are deleted (`update-ref -d`). A `done` session keeps its
checkpoints until it is archived: the transcript is still readable, so the turns should still be revertible.

**Renderer.** `transcript-items.ts` derives a `checkpoint` item from `model.checkpoints[sessionId]` for every
settled turn with changes, keyed by `messageId` to the user row that started it and placed after the turn's last
row (before the next user message). `CheckpointRow` (`features/chat/CheckpointRow.tsx`) is one mono line like a
tool row: `Turn n · 3 files · +40 −8 · Review · Revert this turn`. Revert asks inline — the question replaces the
actions, Escape or Cancel puts them back — and only the confirming click dispatches; it is disabled while the
agent is mid-turn; a reverted turn reads `Reverted` with no actions. Review sets `ui.diffCheckpointId` and opens
the Diff screen, which renders the patch read-only in its own clothes (`screens/Diff/CheckpointDiff.tsx`: header ·
files pane · one block per file, only `Mod+⏎` bound); Done and unmounting leave the mode.

## Consequences

- Every turn writes blobs and two commits into the repo's object store. Blobs the agent also commits later are
  shared; the rest are small. Refs are dropped with the session, after which the objects are ordinary garbage.
- `git add -A` on a very large worktree costs what `git status` costs; it runs off the turn's critical path
  (fire-and-forget), so the agent may already be editing while `base` is captured. The window is the agent's
  first think, small in practice; a capture that lands late attributes an early edit to the previous state.
- A pty session (shell; a CLI without hooks) has no settle signal: its turn settles when the next one starts, so
  its last turn only gets a row once another message goes out. Adding `turnSettled` to the pty quiet timer would
  close that gap; left for the queue work that owns that code path.
- Secret files never enter a checkpoint: the capture's `add -A` carries exclude pathspecs for `.env` / `.env.*`
  (the examples too — a pathspec cannot carve them back out, so an edit to `.env.example` is not captured or
  reverted), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*` / `id_ed25519*`, `.npmrc`, `.netrc` and
  `credentials.json` (`SECRET_PATHSPECS`), so an un-ignored `.env` the agent wrote stays out of the object store; a
  `git push --mirror` from the user would still carry every `refs/styx/` ref, which is why nothing secret may be
  in them. `revert()` refuses a turn already reverted, re-checks the session state inside the queued operation
  (a turn that starts between the click and the run is not undone), and refuses when another live session shares
  the worktree; the restore is two passes — modified and deleted paths first, then only paths that are _still_
  added after the restore are deleted, each confined to the worktree.
- Reverting does not itself create a checkpoint, so a revert cannot be undone from the UI; the `after` refs of
  the reverted turns stay until retention, so the tree is recoverable by hand (`git restore --source=<ref>`).
- Tests: `checkpoint-service.test.ts` over real temp repos (index/HEAD untouched, ignores, numstat, live diff,
  revert incl. staged and nested files, refusal while working, open-turn carry, plain folders, prune);
  `CheckpointRow.test.tsx` (row, inline confirmation, Escape, busy, reverted, placement, ChatPane dispatch);
  `CheckpointDiff.test.tsx`; e2e `checkpoints.spec.ts` drives the fake Codex through a `write <name>` turn.
