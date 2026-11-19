# ADR-0033 — One place for the work: Styx in plain words, as a switchable mode

**Status:** accepted (2026-11-19; phase 1 built, behind a setting) · **Owner request:** "a version of styx but for
marketing — all the tools, connected into one desktop app, giving you superpowers", then "a marketing person doesn't
know what a deployment target is", then "make it do everything that styx does too, but through this paradigm — one
tool to rule them all", and "we still need [projects]". Build it "as a mode for now to switch to for testing"; first
milestone "the whole shabang — UI, UX, connected apps".

## Context

Styx's model is general: a task (lane) runs an AI on a project, reaches outside tools only through scoped, expiring,
audited access, asks before anything risky, and finishes with a result someone accepts. Its words and screens are a
developer's: lanes, worktrees, targets, grants, land, diff. A marketer, an account manager or a busy founder has the
same need (do the work across my tools, ask me before it spends, publishes or sends, keep a record) and none of the
vocabulary.

## Decision

1. **Same engine, plain words.** No new domain model. The mode is a second shell over the read model, with selectors
   in `packages/core/src/selectors/one.ts` that say the same state in plain words:

   | Styx            | One place for the work |
   |-----------------|------------------------|
   | lane / session  | task                   |
   | grant request, open ask, ready to land | Needs your OK |
   | land / publish  | go live                |
   | target (and, next, MCP apps) | connected app |
   | team context    | know-how               |
   | audit log       | record                 |
   | project         | project (kept: a client or product, with its code, apps, tasks, rules and know-how) |

2. **A setting, off by default** (`settings.app.oneMode`, Settings › General). The shell swaps the rail and project
   nav for one sidebar: Home, Needs your OK, Tasks, Projects, Know-how, Connected apps, Record, the project list, then
   Settings and "Back to classic Styx". Classic-only screens map to their match when the mode turns on (Home → Home,
   Approvals → Needs your OK, Agents → Tasks, Repo → the project page) and back when it turns off.
3. **Developer depth one click away, never removed.** A task opens the existing workspace (chat, changes, preview,
   terminal, access). Approving opens the existing grant sheet (Touch ID for production stays). Going live opens the
   existing land dialog. Rules are today's policies, said as sentences. Know-how is today's Team context screen.
4. **Connected apps in tiers** (research: `Composio for Styx connected apps`, 2026-11-18). Tier 1, hand-built: the
   current targets, then the high-value marketing apps (Meta and Google ads, Shopify, Stripe) as provider adapters
   with spend caps. Tier 2: Styx as a gated MCP client for apps that publish a remote MCP server (OAuth with dynamic
   registration and PKCE, tokens in the keychain, tools re-exposed only through `styx mcp`, read-only tools may run,
   everything else asks). Tier 3: OpenAPI/HTTP apps (GET reads, anything else asks). Tier 4: a person's own
   aggregator account (Composio, Pipedream, Zapier) behind the same gate. Composio is not the connector layer: it
   holds the tokens, they cannot be exported, and its approval hooks are experimental.

## Alternatives considered

- **A fork or a separate app.** Two codebases to keep secure, and the marketing side would lose lanes, grants and
  the audit chain on day one. Rejected for now; the mode can become a separate build later from the same tree.
- **Rename things in classic Styx.** Developers lose words they rely on (branch, diff, land). Rejected.
- **Composio (or Nango, Pipedream) as the whole connector layer.** Fast coverage, but token custody leaves the
  machine and approval rules stop being Styx's. Kept only as tier 4, the person's own account.

## Consequences

- Phase 1 (this change): the setting, the shell, Home, Needs your OK with rules, Tasks, Projects and the project page,
  Connected apps (targets), Record. Mockup `design/next/styx-one-place.html`; discrepancy row 182.
- Phase 2: the MCP client tier, with a security review (it touches the broker, the vault and grants).
- Phase 3: the ads apps, which need the owner's developer accounts (Meta app review, a Google Ads developer token).
- The plain views read the same rows as classic Styx, so both shells always agree; a selector change is tested in
  core with full coverage like every other selector.
