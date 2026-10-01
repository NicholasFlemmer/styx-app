# ADR-0027 — Organised around the lane

**Status:** accepted (2026-10-01) · **Owner request:** after the launch, "we need windows, easier to launch an
agent and get a result, more visual — a little less boring … everyone else in this category as well as Styx
feels like an IDE. Why should it?", then, on the mockups, "i really dig it", "use the fonts you have changed to
but keep the sizes you had", "lets get going".

## Context

The launch numbers (discrepancy rows 125–129) show where new people stop. Of the first new installs, some never
start an agent. Those who do are rarely seen getting a result back. The workspace they land in is an IDE layout:
a file tree, an editor, hunks, a terminal, a chat on the side. It asks a newcomer to work the way an IDE works
before Styx has done anything for them.

The handoff (`design/handoff/`) is a terse, IDE-shaped design: uppercase tracked labels, 10px label type,
everything organised around files and tools. The owner has decided to move past it. This ADR records that
decision so the departure is deliberate rather than drift.

The mockups that were approved are in `design/next/`:

- `styx-next-app.html` covers every screen.
- `styx-next-workspace.html` shows the workspace in continual use.
- `styx-next.html` shows the first-run flow.

## Decision

### 1. The lane is the unit

An IDE is organised around files. Styx is organised around a **lane**: one piece of work, made up of its agent,
branch, conversation, changes, preview, checks and access. That is a session on a worktree, which Styx already
has; nothing new is stored.

- **The project nav lists the work, not the tools.** Each live lane appears by its task (`taskOf`), its agent
  and whose move it is, ordered by attention:
  1. Your turn.
  2. Working.
  3. Idle.
  4. Ready to land.
  5. Landed.

  The project's tools follow under "Project": Lanes and branches (the Repo screen), Targets, Agent defaults,
  Env and secrets, and Tech debt audit.

- **Picking a lane opens it in the workspace.** The chat's agent tabs become the lanes in the nav.

### 2. Instruments, not frames

The workspace centre has four tabs on the selected lane: **Preview**, **Changes**, **Code** and **Terminal**.

- **Code** is today's editor, file tree, changes list, hunk bar and "Open in …", unchanged.
- **Preview** is today's Design pane.
- **Changes** is the review, rebuilt as a page (see 3).
- Land, Publish and Deploy stay in the toolbar.

### 3. Results come back on paper

A turn that changed something ends in a paper card, drawn on the light theme's surfaces. The card says what the
turn did and offers Show changes and Undo this turn. Carrying on keeps the turn, and anything stays undoable
until the lane lands. Kept turns fold into one-line receipts.

The Changes tab is the lane as a page:

- A summary.
- Every turn with its own diff, each revertable on its own.
- The checks.
- One decision bar.

The review keys (r, j/k, ⌘⏎) stay.

### 4. Plain words first, raw on demand

A running turn shows a few readable steps. The tool calls are one click away, and the terminal is where it was.

### 5. Places, not pages, on the rail

The two 56px rails become one column:

- The app's places: All projects, Agents, Access (was Approvals), Tasks and Usage.
- The project tiles.
- One Settings tile at the foot.

The eight app settings sections that had their own rail tiles move into a nav inside the Settings screen, with
two groups: "This project" and "App". Every section still exists.

### 6. Calm, not terse

- **Labels:** sentence case, at body or meta size, instead of 10px uppercase tracked labels.
- **Body text:** 14px.
- **Headings:** today's heading typeface (normal-width Archivo, weight 600, -0.02em on large sizes) at the
  mockup sizes. Page titles are 28px; the new-task and onboarding headlines 38–40px; the result headline 30px.
  Wide Archivo is **not** used (owner, 1 Oct).
- **Monospace:** only for code, paths and branch names.
- **Shapes:** colours, square shapes, 1px lines and floating surfaces keep their current recipes.
- **Lime:** marks only the move that is yours.

### 7. New tokens

- **Agent colours:** `--agent-claude`, `--agent-codex`, `--agent-gemini`, `--agent-cursor` and
  `--agent-shell`, each with a light-theme value. They are only ever drawn as a small square beside an agent's
  name.
- **Paper surfaces** reuse the light theme's values (`--paper-*`) so a result card reads the same in both themes.

## Consequences

- **The handoff is no longer pixel-authoritative** for screens this ADR changes. `design/next/` is the
  reference for those, and the handoff stays the reference for everything this ADR does not touch:
  - behaviour;
  - state machines;
  - security;
  - §10 copy, where wording is unchanged.
- **Visual baselines** baked from the prototype stop matching the screens this ADR changes. Those screens
  re-baseline from the app itself as each phase lands; the rest keep their prototype baselines.
- **Nothing is removed.** Every command, setting, screen and keyboard path keeps a home, and each phase's
  discrepancy row lists where each one moved.
- **Delivery is in phases,** each one shippable:
  1. Shell: one rail, the lane nav, the Settings nav, the type pass, the agent colour tokens.
  2. Chat: lane header with Land on main, turn cards on paper, receipts, readable steps.
  3. Workspace instruments: Preview / Changes / Code / Terminal; Changes as the paper review page.
  4. New task inline, replacing the Spawn modal, with starter tasks.
  5. Home, Agents (four columns), Lanes, Access, Usage, Agent connections, Onboarding, Palette ("start as a
     task"), New project, Connect, the toast.
