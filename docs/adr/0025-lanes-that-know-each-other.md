# ADR-0025 Lanes that know about each other

Status: accepted · 2026-09-19 (owner request; design and research in `docs/research/lanes-that-know-each-other.md`)

Two lanes on this repo edited the same seven files a day apart and neither agent knew the other existed on those
files. Styx flagged the conflict only after both had committed, and its whole answer was abort, mark, pause. The
research (a 2026 study of 33,596 agent PRs; multi-agent workspace practice; GitHub's "Fix with Copilot") points one
way: prevention through awareness and small frequent syncs beats cure, which beats a gated landing — and the
awareness part is what nobody in the desktop-orchestrator space does.

The owner set the product frame: two personas on one machine — the senior developer who reviews and merges, and
the solo builder who wants it to work and never lose anything — with **auto** as the default and review one
switch away. This ADR covers phase A, awareness; phases B (resolution) and C (landing) follow.

## Decision

1. **A lane ledger** (`LaneLedgerService`, main) derives what every live lane is doing from rows and git that
   already exist: its task (`taskOf`: the first line of the first message, else the latest `report_status` note),
   the files it changed against the base (`git diff --name-only <base>...HEAD` ∪ `git status`), and what the base
   gained since the lane was cut (`git log <lane>..<base> --name-only`, each merge of a Styx lane attributed to
   that lane's owner). Nothing new is stored except `Worktree.overlaps` (migration 0018).
2. **Agents see the project, not just their worktree.** `list_sessions` grows `task`, `files` and
   `overlapsWithYou`; a new broker tool `project_activity` returns the base commits not yet merged, the other lanes
   and every overlapping file; the spawn prompt lists the other lanes with task and files (`agentPrompt.lanesNow`)
   and tells the agent to read `project_activity` and use `send_message` before touching shared files.
3. **A warning at write time, never a lock.** After every hunk rescan the ledger recomputes overlaps for the
   project; when two lanes have changed the same file both chats get one system line — once per file pair —
   naming the other lane and its task. Hotspot files (`ProjectSettings.hotspots`, defaulting to
   `DEFAULT_HOTSPOTS`: package files and lockfiles, migrations, `copy.ts`, routes/registries, the discrepancy table)
   get the louder line. The Repo lane row shows `overlaps <branch>`; the Spawn modal lists what is already running.
   Advisory by design: enforced pre-write admission (ATM) is a different product, and the study's own
   recommendation is a claim protocol that informs.
4. **Small merges, often.** `ProjectSettings.autoSync: 'turn' | 'publish' | 'off'` (default `turn`): at every
   turn boundary — the agent has just gone quiet, so nothing lands under a write — a lane behind the base whose dry
   run is clean brings the base in and says so in one line. A lane that would conflict is marked and paused as
   `refresh` marks it, and left for the resolution flow (phase B): an automatic merge never leaves markers behind.

## Phase B — Styx finishes the merge

A conflicting base merge is no longer abandoned (`MergeResolveService`):

1. **Checkpoint, then merge in place.** HEAD and, when the tree is dirty, a checkpoint commit of the working tree
   are recorded on the lane (`Worktree.resolution`, migration 0019); `rerere.enabled` is set; the merge is left in
   progress. What Mergiraf can settle mechanically is settled and staged when the tool is on the login PATH; a merge
   with nothing left is committed as an ordinary sync.
2. **The lane's own agent resolves, with both intents in hand.** A Styx-authored turn (a `system` row, never the
   human's words) names every conflicted file with _yours_ (the lane's task and its commits on the file) and
   _theirs_ (the base's commits on it), the rules (keep both sides; append-only documents are appended and
   renumbered; touch only what the conflict forces; never abort or commit), and the checks to run. A lane whose
   agent is gone gets a hidden `merge` task on the same lane with the project's default agent.
3. **Verify before it counts.** When the agent goes quiet: no merge aborted, no markers left in the conflicted
   files, then `ProjectSettings.checksCommand` run in the lane (learned once by the agent through
   `remember_command` kind `checks`, accepted only from the session finishing a merge). Green → `add -A`, the merge
   commit with both intents in its message, the row current, one plain line in the chat, a Home row. Red → the
   reason and the output tail go back as one more turn (`MAX_ATTEMPTS = 2`); red again → the merge is undone (abort,
   reset to the pre-merge HEAD, the tree checkpoint restored) and the lane is marked as before.
4. **Undo.** `worktree.undoResolve` puts the lane back to before the merge while nothing has been committed on top;
   the Repo row offers it as `Undo merge`.
5. **Who waits.** `ProjectSettings.integration` (`auto` by default, owner decision): in auto a conflicting
   turn-end sync or `Bring in main` goes straight to the resolver; in review the lane is marked and the chat says
   `Resolve` asks the agent. Both modes commit the resolution — a half-merged tree is the one state an agent must
   never inherit — and differ in the line the chat gets. Landing (phase C) gates on review.

## Phase C — Landing

A lane's work reaches the base branch in one step (`LandService`, `worktree.land`), from a `Land` button on the
Repo lane in auto mode and a `Merge into {base}` button in review mode (Publish → PR stays for the reviewer):

1. **Everything the lane did, then the base first.** What the agent left uncommitted is committed through
   Publish's own commit step (by name; secret files stay out; the user's identity), the base is brought into the
   lane (a conflict goes to the phase B resolver and the landing stops with "land again when the lane says it is
   done"), and the project's `checksCommand` runs in the lane. Nothing reaches the base until all three hold.
2. **One commit on the base, in the base's own checkout.** `git merge --no-ff` in the main folder with the summary
   as the record — drafted by the project's default agent from the changes (`worktree.generateMessage`), editable in
   the Land modal — after the folder is checked to be on the base and clean. A merge conflict here (only possible if
   the base moved between the sync and the merge) is aborted and reported.
3. **Push through Publish.** When the project has a remote the base is pushed through `PublishService.publish`
   (`through: 'push'`) on the main worktree: the same grant, audit and activity path as the Publish button.
4. **The lane stays, landed.** `Worktree.landing` (migration 0020) records the landing commit, the base, whether it
   was pushed and when; the row reads `landed today` and offers `Undo landing` (`worktree.undoLand`: `git revert
   -m 1`, pushed again if the landing was) while the landing is still the base's HEAD, then `Archive`. The lane's
   chat gets one plain line; Home gets a row.
5. **One at a time per project.** Landings queue per project; the next brings the freshly moved base into its lane
   before it merges — the serialised, gated merging the research recommends over parallel merges racing each other.
6. **Trust is earned.** `ProjectSettings.autoLand` (off by default, auto mode only, owner decision): a session that
   ends cleanly (exit 0, not a hidden task) lands its lane by itself with the file-list summary — never a prompt
   spent silently — and a refusal is one line in the chat, with Land still on the Repo row. Landing needs the
   lane's agent quiet; a lane mid-turn, mid-resolution, already landed, or with nothing the base lacks is refused
   before anything is touched.

## Consequences

- `Worktree.overlaps`, `ProjectSettings.autoSync` / `hotspots` (also written to `.styx/project.json`), broker
  protocol `list_sessions` fields and `project_activity`, `GitService.diffNames` / `logRange`,
  `HunkService.onRescanned`, `LaneSyncService.autoSync`, `AgentLaunchContext.lane.others`.
- Only Claude Code receives the system-prompt block today; the Codex, Gemini and Cursor adapters pass no
  instructions at launch (a pre-existing gap, now more visible) — their agents still get the chat lines and the
  broker tools.
- Phase B adds `Worktree.resolution`, `ProjectSettings.integration` / `checksCommand`, `MergeResolveService`,
  session purpose `merge`, `remember_command` kind `checks`. Phase C adds `Worktree.landing`,
  `ProjectSettings.autoLand`, `LandService`, `worktree.landPreview` / `worktree.land` / `worktree.undoLand`,
  `GitService.mergeNoFf` / `revertMerge` / `numstatFiles`, `SessionHooks.sessionFinished`, the Land modal.
- `LaneSyncService.save` now writes only the fields it owns onto the row as it is (head, conflict, behind), so a
  landing or resolution set meanwhile survives a refresh — the same rule `HunkService` and the resolver follow.
- Not yet: archiving a landed lane by itself (Archive stays a click), and a landing across a lane whose agent is
  Codex, Gemini or Cursor gets the same chat lines but no launch-time instructions (the phase A gap).
