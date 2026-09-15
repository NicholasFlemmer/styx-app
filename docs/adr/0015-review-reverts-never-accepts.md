# ADR-0015 The diff review reverts or marks reviewed; nothing "accepts"

Status: accepted · 2026-09-15

Agents write straight into their worktree; Styx's hunk watcher only detects the result. "Accept" therefore never
applied anything — it staged the hunk (`git apply --cached`) and left the working tree untouched, while "Done"
returned a count named `applied` without applying. The owner called this obsolete from real use, and the code
agreed. The review keeps the two verbs that mean something: **Revert** (reverse-apply the hunk, the old reject)
and **Done / Mark reviewed** (the hunk stops being flagged in the editor and the hunk bar; no git call). The
`accepted` status value is kept in the database and the core enum with the meaning "reviewed", so no migration
is needed; `.styx/project.json` hunks are never bulk-marked (the H-1 trust gate still routes policy changes
through the project-policy banner).

Rejected: inverting the model so agents write to a staging area and accept applies (fights the threat model in
docs/plan.md that agents are the user's own processes), and keeping accept as pure bookkeeping under its old
name (a label that reads as "apply" but does not).
