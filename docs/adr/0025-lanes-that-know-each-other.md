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

## Consequences

- `Worktree.overlaps`, `ProjectSettings.autoSync` / `hotspots` (also written to `.styx/project.json`), broker
  protocol `list_sessions` fields and `project_activity`, `GitService.diffNames` / `logRange`,
  `HunkService.onRescanned`, `LaneSyncService.autoSync`, `AgentLaunchContext.lane.others`.
- Only Claude Code receives the system-prompt block today; the Codex, Gemini and Cursor adapters pass no
  instructions at launch (a pre-existing gap, now more visible) — their agents still get the chat lines and the
  broker tools.
- Not yet: resolving a conflict with the lane's own agent, and landing (merge into main, push, archive) with the
  review / auto switch. Both build on this ledger.
