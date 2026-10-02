# ADR-0028: Design before you build — design and build tasks, select to fix, tabs in your order

- Status: accepted (owner, 2026-10-02)
- Context: discrepancy rows #138–#140; mockups `design/next/styx-next-tasks.html`, `design/next/styx-next-design.html`

## Decision

1. **Two kinds of task.** A task is a *design* task (draws screens) or a *build* task (writes code), chosen when it
   starts (`session.kind`, migration 0021; absent = build). Tasks cards say which.
2. **Designs are files in the task's worktree** under `.styx/designs/`: `<screen>/<size>.html` (desktop 1280,
   tablet 834, phone 390), `<size>.wire.html` for wireframes, `tokens.json` (colours, typefaces, type scale, corners,
   spacing) and `tokens.css` written by Styx from it. A design task's agent is briefed on the layout ahead of its
   first turn (`copy.agentPrompt.design`); Styx seeds the tokens when the task starts. Designs are reviewed, kept and
   landed like any other work — no separate store, nothing lost in a tool.
3. **The Design tab** draws every screen at every size on a canvas, in sandboxed frames with no scripts
   (`sandbox="allow-same-origin"`): the renderer reads and edits the documents, the screens never run code, and
   anything written back is stripped of scripts and inline handlers in main. The project nav steps aside for room.
4. **Point, don't describe.** Select picks one element (click) or an area (drag) — in Design and in Preview. Hand
   edits (text, fill, colour, type, corners) save to the file. *Tell the agent* sends the note with a picture of the
   selection and a pointer: the chip label stays on the transcript row; the detail (screen, selector, markup, source
   lines where the page says) goes to the agent only. In Preview the pick runs as a script in the dev page and its
   result is parsed as untrusted text.
5. **Handover links tasks.** *Build it* starts a build task branched from the design's lane (Styx commits
   `.styx/designs` there first), linked by `designSessionId`, or carries on in the design task. When the design
   changes afterwards (a hand edit, Type and colour, or a design turn that wrote screens), Styx commits it in the design
   lane and tells each build task what changed and how to bring it in. A fix picked in Preview can be marked a design
   problem and goes to the design task instead.
6. **Tasks are summaries** (#139): a card per running task with its live status; a click opens the lane.
7. **Tabs in your order**: drag, right-click (Move left / right / to front / Reset) or Alt+Shift+←/→; kept in app
   settings (`instrumentOrder`). With an order set, a project opens on its first tab.

## Consequences

- Design screens are plain HTML any agent can write and any person can open; the build reads them as reference.
- The canvas trusts nothing in a screen: no scripts run, links do not navigate, saved files are scrubbed.
- A build task only sees design changes after Styx commits them in the design lane and the build merges them in.

## Security review (before release)

- Design files are read and written without following links: the worktree is resolved for real, `.styx`,
  `.styx/designs`, a screen's folder and the file itself must not be links, writes open `O_NOFOLLOW` and refuse a
  file with more than one name (hard link) before truncating.
- Styx's own commits of the design folder (`GitService.commitOwnedPaths`) run with hooks, fsmonitor and signing off,
  `--no-verify`, only the given paths, and only when the worktree's git common dir is the project's own.
- Each design frame starts with its own policy (`default-src 'none'`, inline styles, data: images and fonts, no
  frames, no forms) ahead of the agent's markup; DNS-prefetch / preconnect hints and `http-equiv` metas are dropped.
- A build task links only to a live design task of the same project.
