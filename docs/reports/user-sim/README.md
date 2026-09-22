# User simulations

Scripted walkthroughs of the **built app** that do what a person does — click, type, spawn, approve, publish, land —
against the demo fixture, the fake CLIs in `apps/desktop/e2e/fixtures/bin` and bare git remotes in a temp folder.
Nothing real: no remote, no keychain, no CLI that spends anyone's usage.

Unlike the e2e suite, a failed step does not stop the run: it is recorded with a screenshot and the walk goes on, so
one report covers an area end to end. A step that cannot judge an outcome records a **finding** (blocker / major /
minor / polish) with the repro, what was expected, what was seen and where in the code to look. The report per area
is `<area>.md` in this folder; screenshots land in `apps/desktop/e2e/sim/out/<area>/` (not committed).

| Area | What it walks |
| --- | --- |
| `onboarding-shell` | first run, the four onboarding steps, the palette, the keyboard map, banners, theme, the window minimum |
| `home-settings` | Home counters / rows / feed, every Settings section, Agent connections, Skills, New project, Add from recent, relaunch |
| `workspace-chat` | files, editor, hunks + Diff review, terminal, chat turns with the fake Codex / Gemini, queue / steer, drafts, attachments, pop-out |
| `agents-approvals` | the board, spawn, asks from board / inbox / chat, grants, policies (+ Rule), audit log, tasks, usage |
| `repo-publish` | lanes, Publish (commit / push / PR), Connect to GitHub, Land, Undo, Bring in main, conflicts and Resolve |
| `design-deploy` | the design window, Run locally (learn / run / stop / fix), device runs, Deploy to live, targets, Connect target |

## Run one

```sh
pnpm build
cd apps/desktop
env -u ELECTRON_RUN_AS_NODE node --experimental-strip-types e2e/run.ts --project sim --grep <area>
```

A run takes one to eight minutes. Two at a time is fine on a laptop; more and the fakes start timing out.

## Reading a report

Findings first, then the step table. A failed step whose note starts with a locator timeout is usually the sim's
own hook (a selector, a case, a modal left open), not the app — fix the sim. A finding is the sim's judgement about
the app; the ones confirmed and fixed are listed in `docs/handoff-discrepancies.md` row 109. Findings that name the
demo fixture (a remote the seeded repo never had, hunk rows in prototype quotes) are fixture drift, kept so the
next person does not chase them.
