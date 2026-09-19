# Lanes that know about each other, and merges Styx finishes

Status: accepted 2026-09-19 (auto by default; land on a click first, automatic landing as an opt-in; the checks command learned by the agent) · owner request ("Styx doesn't really resolve anything. We can't have agents trample
each other, and agents need to understand what has been done at a project level — not just a worktree. Two personas:
the senior developer who reviews diffs and merges to main themselves, and the solo builder who just wants it to
work, never overwrite work, and doesn't read diffs.")

## 1. What went wrong, concretely

Two lanes on this repo this week — `agent/claude-1` (1bbe4df, "refuse a wrong Locate-binary pick, Forget binary")
and `agent/claude-4` (5901093, "find CLIs the way the terminal does, install from Styx") — edited the **same seven
files** about a day apart: the detector, `detect.setBinary`, the Connect agent modal and its test, `copy.ts`, the
container, the discrepancy table. Neither agent knew the other existed on those files. Styx's dry run
(`git merge-tree`) flagged the lane as conflicting only after both were committed.

What Styx does with a conflict today (ADR-0023): `worktree.sync` merges, sees the conflict, **aborts**, marks the
lane, pauses the agent, and the Repo lane's "Resolve" action opens the diff. Publish stops with the file named. The
merge that finally happened was done by the lane's own agent by hand: it had to reconstruct the other lane's intent
from `git log`, renumber two documents by inspection, and fight the repo's secrets hook because the merge diff
carried main's own test fixtures. None of that was handed to it by Styx.

What an agent knows about the project today: `list_sessions` returns `agent · branch · state · note` for the other
sessions; the spawn prompt says other agents may exist and how to message them; the chat gets one line when the
base moves ("main moved: 3 new commits"). No files, no tasks, no "who touched what I am touching".

## 2. What the field says

- **33,596 agent PRs (2026 study).** 40 % of repos had overlapping agent PRs on the same day; the pairs that overlap
  conflict at **41.7 % across agents** (19.8 % within one agent). 57.6 % are content conflicts, 26.8 % modify/delete,
  15.1 % add/add — the last two (~42 %) cannot be merged mechanically at all. Recommendations: partition tasks by
  file boundaries, **claim protocols** (register what you will touch before touching it), run `merge-tree` during
  development rather than at PR time, merge **sequentially with CI gating**, and "formalised live workspace
  communication protocols — infrastructure currently absent from mainstream tools".
- **Multi-agent workspace practice (Augment guide).** Ownership manifests per task; a **single-writer rule for
  hotspot files** (route tables, registries, config); rebase one branch at a time onto main; textual conflicts are
  cheap when caught early, **semantic conflicts need a human**; tests + review before merge.
- **ATM (arXiv 2607.00041).** Enforced pre-write admission through a broker: agents declare intent, a neutral
  steward applies writes. Proves the shape; far too heavy for two to five lanes on a laptop. The _advisory_ form —
  claims that warn, never block — is what fits Styx.
- **Mergiraf.** A syntax-aware git merge driver that quietly resolves the "both added an import / adjacent edits /
  duplicate keys" class and keeps conflict markers whenever unsure. Cheap to adopt when present on the machine.
- **GitHub, March–April 2026.** "Fix with Copilot" on a PR: the agent resolves the conflicts _in its own
  environment_, **runs the build and tests**, and pushes; the human reviews the PR. That is the industry's cure
  pattern: agent resolves, checks gate, human reviews (or, for a solo owner, doesn't).
- **Replit Agent / Lovable.** No branches for people who don't use git: one line of history, checkpoints, "restore".
  **Claude Code** offers `--worktree` for parallel sessions and nothing for coordination. **Conductor** gives each
  task a workspace, a diff viewer and PR/merge/archive — and documents no cross-workspace awareness either.

Takeaway: prevention (awareness, partition, small frequent syncs) beats cure (agent resolution with verification),
which beats landing (serialised, gated). GitHub does the cure on the server; nobody in the desktop-orchestrator
space does the prevention. Styx already owns every ingredient — the hunk watcher knows which files each session
touches, checkpoints exist, Publish drafts summaries with the user's own agent, the broker reaches every agent.

## 3. Two people, one machine

|                   | Senior developer                                                                                                                                              | Solo builder                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Wants             | to see the diff, decide the merge, own main                                                                                                                   | it to work, never lose anything, no git words                      |
| Sees              | lane rows with `↓n main`, overlap tags, merge diffs, PRs                                                                                                      | "Claude's checkout work is in your project · Undo"                 |
| Conflicts         | resolved by the agent, **shown for review** before it counts                                                                                                  | resolved by the agent, **checked, then done**; undo one click away |
| Landing           | Publish → PR, or "Merge into main" with the same gate                                                                                                         | "Land" — merge, push if there is a remote, tidy up                 |
| Invariants (both) | a checkpoint before every merge; undo everywhere; nothing half-merged is ever left for the human; the same explanation in plain words is available either way |

Same machinery, different exposure. The switch is one project setting, in plain words, with a detected default.

## 4. Design

### 4.1 The project ledger — agents and people see the whole project

**Data (main process, derived, no new tables):** per live lane — its task (the first message, then the latest
`report_status` note), the files it has changed against the base (`git diff --name-only <base>...HEAD` ∪ uncommitted
from the hunk watcher), last activity; per project — what the base gained since each lane was cut (commits, their
files, and the Styx lane or PR each came from), and lanes landed recently.

**Agents get it three ways:**

1. `list_sessions` grows `task` and `files` (with `overlapsWithYou: [...]`), so "who is on what" is one call.
2. A new broker tool `project_activity` — "what changed in this project since your lane started": base commits
   with files, other lanes' files, and the overlap with the files you have touched.
3. The spawn prompt (`agentPrompt.lane`) lists the active lanes with their tasks and files, and the rule: check
   before starting on a file another lane has changed; when Styx hands you a merge, keep both sides.

**People get it in the Spawn modal** ("2 lanes active — Claude on Connect agent (7 files), Codex on checkout (3)")
and on the Repo lane rows (an `overlaps with <lane>` tag next to `↓n main`).

**Live overlap warnings (advisory claims).** The hunk watcher already reports every file a session touches. The
moment lane B writes a file lane A has changed (uncommitted, or committed since the base), both chats get one
system line naming the other lane, its task and the file, and pointing at `send_message`. Never a block — the study
and the ATM paper agree blocking is a different product; a warning at write time is what turns a 41 % conflict rate
into a conversation.

**Hotspots.** A project setting (globs; detected defaults such as `packages/core/src/copy.ts`, migrations, the
discrepancy table, route/registry files) where the warning is louder and suggests a single writer. Append-only
documents get a convention agents are told: append, never renumber another lane's rows.

**Keep lanes fresh.** `autoSync: 'turn' | 'publish' | 'off'`. At `turnSettled` (the safe moment ADR-0023 could not
use — the agent is idle), if the lane is behind and the dry run is clean, bring the base in silently with one chat
line. Small, frequent merges are the single biggest conflict reducer the research names; today's sync only runs on a
click or at Publish.

### 4.2 Styx finishes the merge

Today a conflicting sync aborts. Instead:

1. **Mechanical first.** `rerere.enabled` on every Styx worktree (a resolution is never made twice); Mergiraf as the
   merge driver when it is on the machine (detected like an agent CLI; "Install for me" later). Both are
   conservative by design — they leave markers when unsure.
2. **The lane's own agent resolves — with both intents in hand.** Keep the merge in progress and give the owning
   agent a Styx-authored turn: the conflicted files; for each, _yours_ (the lane's task and its commits on that
   file) and _theirs_ (the base commits on that file with their messages and, when they came from a Styx lane, that
   lane's task); the rules (keep both behaviours, drop neither; append-only docs are appended, not renumbered;
   never touch files outside the conflict); the checks to run; finish with `report_status`. Agents are good at this
   when they know _why_ each side changed the line — the missing piece in the hand merge above was exactly that.
3. **Styx verifies before anything counts.** No markers left, `git diff --check`, then the project's checks
   command (`checksCommand`: learned once by the agent like Run locally / Deploy, or read from the repo's scripts —
   typecheck, tests, lint). Green → a checkpoint of the lane is taken, the merge is committed with a message naming
   both intents, the lane is current, the chat gets the plain line. Red → the failure goes back to the agent once;
   still red → abort, lane marked, plain explanation, and for the senior an "Open in editor" beside "Ask <agent>
   again".
4. **Ownerless lanes** (the agent is done or archived) get a short `purpose: 'merge'` task session with the
   project's default agent — the same hidden-task shape as the tech-debt audit — running the same turn.
5. **Review vs auto is only who waits.** Both modes commit the resolution (an uncommitted half-merge is the one
   state agents must never inherit). _Review_ announces it as "Review merge" on the lane with the resolution diff
   (`git diff HEAD^1..HEAD` on the conflicted files) and does not let the lane land until it is looked at; _auto_
   announces "Brought in main — two files were changed by both you and Claude-1; kept both, checks pass · Undo" and
   moves on. Undo restores the pre-merge checkpoint.

### 4.3 Landing — the persona switch

Project setting `integration: 'review' | 'auto'`, under Settings › Agent defaults in plain words ("I review and
merge myself" / "Keep my project up to date for me"). Detected default: a remote with branch protection or more
than one collaborator → review; a repo with no remote, or a personal remote → auto. Always switchable.

- **review** — what exists today, completed: `↓n main` and overlap tags on lanes, Bring in main, Publish → PR,
  plus a local "Merge into main" (`--no-ff`, the agent-drafted message) behind the same gate.
- **auto** — a lane **lands** when its session finishes or on a click: bring in main → resolve (4.2) → checks →
  merge into main (`--no-ff`, message = the agent's drafted summary) → push if there is a remote → archive the
  lane. One lane lands at a time (a merge queue: the next one brings main in first, which is exactly the
  sequential CI-gated merging the research recommends). Home and the chat say: "Claude's work on the checkout page
  is now in your project · Undo". Undo is `git revert -m 1` of the landing commit, shown as one word.
- **What changed, in words.** Publish's `generateMessage` already drafts a summary with the user's own agent; auto
  mode shows that plus the file list. Hunks and diffs stay one click deeper for whoever wants them.
- Trust is earned: landing waits for a click at first; "land automatically when checks pass" is an opt-in below it.

### 4.4 What this changes for the agent prompt

`agentPrompt.lane` gains: the active lanes at spawn; "Styx tells you when another lane changes a file you touched
— read `project_activity` before starting on shared files, and use `send_message` to agree who does what"; and the
merge rules of 4.2.

## 5. Build plan

| Phase              | What lands                                                                                                                                                                                    | Size     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **A — Awareness**  | ledger selectors; `list_sessions` + `project_activity`; spawn prompt and modal; overlap lines and lane tags; hotspots setting; `autoSync` at turn end                                         | 2–3 days |
| **B — Resolution** | rerere; merge kept in progress; the resolution turn with both intents; `checksCommand` (learned); verification; checkpoint + commit + undo; `purpose: 'merge'` sessions; review/auto announce | 3–4 days |
| **C — Landing**    | `integration` setting + detection; Land (merge → push → archive) with the queue; plain-language summaries; Home rows                                                                          | 2–3 days |
| D — Polish         | Mergiraf detect / install; Windows verification                                                                                                                                               | later    |

Each phase: core selectors and copy with tests, main services with in-memory tests, contract commands, renderer
with tests, an ADR (0025) and a discrepancy row. Nothing in the handoff covers this; it is an owner addition end to
end.

## 6. Decisions (owner, 2026-09-19)

1. `integration` defaults to **auto** for every project; review is one switch away. (Detection by remote shape was dropped.)
2. Auto mode lands on a click first; fully automatic landing is an opt-in once trusted.
3. The checks command is learned by the agent the first time, like Run locally, and stays editable in settings.

Phase A (awareness) shipped as ADR-0025.

Sources: [When Agents Collide — 33,596 PRs](https://codex.danielvaughan.com/2026/07/28/agent-pr-merge-conflicts-concurrent-coding-agents-codex-cli-worktree-isolation-coordination-defence/) ·
[AgenticFlict dataset](https://arxiv.org/pdf/2604.03551) · [ATM: pre-write admission](https://arxiv.org/abs/2607.00041) ·
[Augment: multi-agent workspace](https://www.augmentcode.com/guides/how-to-run-a-multi-agent-coding-workspace) ·
[Mergiraf](https://mergiraf.org/) · [GitHub: ask @copilot to resolve conflicts](https://github.blog/changelog/2026-03-26-ask-copilot-to-resolve-merge-conflicts-on-pull-requests/) ·
[GitHub: fix conflicts in three clicks](https://github.blog/changelog/2026-04-13-fix-merge-conflicts-in-three-clicks-with-copilot-cloud-agent/) ·
[Replit Agent](https://docs.replit.com/replitai/agent) · [Claude Code worktrees](https://code.claude.com/docs/en/common-workflows) ·
[Conductor](https://www.conductor.build/docs/) · [Cursor worktrees / orchestration layers](https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution)
