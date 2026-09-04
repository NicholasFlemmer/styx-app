---
name: state-machine-change
description: Modify the Session or Grant state machine in packages/core with exhaustive transition tables and tests. Use whenever a state, event, guard, or effect changes.
argument-hint: '<session|grant> <change summary>'
allowed-tools: Read, Grep, Edit, Write, Bash(pnpm:*)
---

# State machine change: $ARGUMENTS

1. Quote the spec §1 rule being implemented (`/spec-lookup 1`).
2. Update the `State`/`Event` unions and the transition table in `packages/core/src/machines/<name>.ts` (object-literal table, not if-chains) so exhaustiveness errors surface missing cells. Invalid pairs return `null`.
3. Effects are data (`{ type: 'startExpiryTimer', grantId, at }`), executed by main.
4. Tests: table-driven over every (state, event) pair incl. invalid; invariants: needs-you never times out; `always` never expires; one open grant ask per session.
5. Update the Mermaid diagram in `docs/state-machines.md`.
6. Run `pnpm test -F @styx/core --coverage` (100% on machines) and the `state-machine-auditor` subagent.
