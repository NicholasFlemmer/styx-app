# ADR-0018 Run, deploy and tech debt audits use hidden background sessions

Status: accepted · 2026-09-16

Run locally, the first deploy to a target, and tech debt audits previously spawned a session and navigated to
its chat. These actions now open a modeless progress dialog. Their prompts and existing grant checks remain
the execution mechanism. A remembered run/deploy command retains its existing execution path.

The session's persisted `purpose` distinguishes a task from an ordinary chat; `taskTargetId` identifies a deploy
target. Tasks stay in the read model for progress, approvals and reports, but are excluded from chat tabs,
agent-board cards and agent palette results. The main service deduplicates active tasks by project, purpose and
target. Renderer startup feedback appears before detection/spawn finishes and never changes the selected project.

The dialog leaves project navigation interactive and can be closed without cancelling work. Tasks in the sidebar
reopens progress and results, including after a renderer reload. Tech debt audit is also a permanent project
navigation action, available outside Worktrees and for plain folders. Questions and permissions are answered in
the task dialog; target grants still use the existing grant sheet and MFA flow.

A structured runner's completed turn finishes the task and releases its process and session grants. Errors and
cancellation remain distinct from completion. Terminal-only agent versions cannot run hidden tasks because their
interactive prompts would be inaccessible; the dialog explains that the agent needs updating. Normal interactive
sessions retain their existing lifecycle. Reports use the persisted transcript and its existing retention policy.

Validation covers startup/navigation races, duplicate starts, hidden-session selectors, persisted reports,
permissions, cancellation and failures. An Electron test uses the fake Codex app-server to exercise the full
approval flow while switching projects and reopening the report after a reload.

## Addendum (2026-09-21) — tasks run without asking, unless told otherwise

A task spawned with the person's chat defaults (`permissionMode: 'default'`, Styx not approving edits) asked at
every step — Run locally, Deploy and the audit each turned into a string of approvals for a job Styx itself had
started. Owner decision: a Styx task is a bounded job on the person's behalf, so it runs in its own mode,
`ProjectSettings.taskPermissionMode`, `bypassPermissions` by default, with the same six modes on offer. It is a
row under Agent defaults and a select in the task dialog; changing it there sets the project's mode and, for a
task still running, `session.configure` switches the session at once (Claude live over the stream, Codex at its
next turn). The merge resolver's hidden task (ADR-0025 phase B) uses the same mode. Styx's own edit approvals
follow it (`taskAutoApprovesEdits`): every mode but "ask each time" and plan. The person's ordinary sessions
keep `permissionMode` as before.
