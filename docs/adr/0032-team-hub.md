# ADR-0032 — The team hub: a shared space on a server that Styx connects to like a target

**Status:** accepted (2026-11-13; phase 1 built) · **Owner request:** "we need a shared context on a server where we can connect
styx agents too, so we can collaborate on anything and everything", then: a team, on a server in Launchsite, with
partitions, an interface on the server, two-way communication, shared artifacts, links, shared approvals and
connectors to external tools — "basically like an internal target". A Styx feature that Launchsite hosts (one
service, many teams, Launchsite owns it; self-hosting stays possible); team-owned approvals only; sign-in limited to
the `launchsite.co.za` Google Workspace for now.

## Context

On one machine, Styx lanes already know each other (ADR-0025): `list_sessions`, `send_message` and
`project_activity` run over the local broker, and every lane sees the others' tasks and files. Nothing crosses a
machine. Two people on one product, or one person with a laptop and a Windows VM, have agents that cannot see each
other, cannot hand over work, and cannot share what they produced except through git and chat apps.

Git already shares code. What is missing is everything around it: what each agent is doing, what it found, the
files it made that do not belong in the repo (screenshots, reports, builds), the decisions people took, and who may
approve what.

The security invariants do not move: secrets for a person's targets live only in their OS keychain, every grant is
audited locally, and prod write/deploy needs OS authentication on the approving machine.

## Decision

**Styx desktop is the pilot seat; the hub on the web is home base** (owner). Work is flown from the desktop: lanes,
agents, grants, the keychain. What the team keeps (context, decisions, shared results, reviews, approvals,
connectors) lives on the hub, always there and always reachable by any member's agents.

### 1. The hub is a target

A new provider, `hub`, sits beside `gcp`, `ssh` and the rest (`providers/types.ts`). Connecting it is the same
flow as any target; agents reach it only through a grant, scoped `read` (read threads, notes, artifacts),
`write` (post, share, request approval) and `delete` (remove what they posted). The hub's grants appear, expire and
audit exactly like the others. Signed out of the hub, Styx works as before: it is a layer, never a dependency.

**As built in phase 1** (discrepancy row 173): the hub is connected once per machine in Settings › Team hub, like
the Styx account, rather than as a per-project row in Targets, and agents are gated by the person's two choices
instead of a grant: `hub_context` and `hub_read` need the project linked to a space; `hub_post` and `hub_remember`
need the lane shared. The hub holds no credential an agent could misuse, and sharing is already an explicit,
revocable, audited act, so a grant on top would ask the same question twice. Every hub call is audited locally
(`used`, target label `team hub`) and on the hub. Grants return with phase 4, where an approval on the hub issues
a credential for a team-owned target.

### 2. One service, many teams, partitioned by space

| Level       | What it is                                                           |
| ----------- | -------------------------------------------------------------------- |
| **Team**    | The customer: members, billing, connectors, sign-in rule             |
| **Space**   | A partition inside a team (a client, a product, a squad)             |
| **Project** | A repo inside a space, matched to a Styx project by its git remote   |
| **Thread**  | A conversation inside a project or space; lanes and people post here |

Members hold a role per space: `owner`, `member`, `viewer`. Every row carries `team_id` and `space_id`, and
Postgres row-level security enforces them from the session's claims, so a bug in a query cannot read across a
partition.

What the database enforces, exactly (the Postgres store, `apps/hub/src/store-postgres.ts`): row-level security
holds every signed-in request to the **teams** its person belongs to (`hub.user_id`, set per transaction, against
`team_members`). Spaces inside a team are enforced by the handlers alone, not by RLS: a space is created before its
first member exists, team-layer context sits in no space, and a repo is looked up across a person's teams, so a
space-level policy would need exceptions for each. Within that, a row's `(space_id, team_id)` must name a real
space of that team, the sign-in paths' role sees no content tables at all, and `audit_entries` refuses update,
delete and truncate by trigger. Artifacts live under `gs://<bucket>/<team>/<space>/…` with no public ACL.

### 3. Nothing is shared until someone chooses to share it

Owner: "you might have only certain results, or tasks you want shared and others you don't", "it could also be a
lane … we need choices". Linking a project to a space only sets where shares go; it shares nothing by itself.
One **Share** action, on anything, with three choices:

| Choice       | Options                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------- |
| **What**     | A result (build, data, file, diff, summary), a lane, or a project                                  |
| **How much** | For a lane or project: _status_ (task, branch, progress, owner); _status + results_ (everything    |
|              | shared from it, as it is made); _everything, live_ (also transcript and changes; redacted, warned, |
|              | terminal never included)                                                                           |
| **To whom**  | The space, named members, or a link (expiring, revocable)                                          |
| **How**      | Once (snapshot) or live (follows updates); for review (asks approve / changes) or for information  |

- **Results** become items in the space with their own thread. A static build (a landing page) is uploaded as a
  snapshot and served from an isolated origin, so it does not depend on the sharer's machine being on; data renders
  as a table, with a warning before anything that looks like personal data leaves; a diff gets line comments.
  Sharing again makes a new version beside the old one.
- **Review comes back.** Comments and the verdict arrive in the source lane as a card (section 8 applies); the
  person decides whether the agent acts on them.
- **Defaults are rules, not surprises.** A project can carry share rules ("lanes share status with Acme", "builds
  go to Acme for review"). Agents may propose a share; the person confirms unless a rule covers it.
- **Unshare** at any time; links revoke at once. Unsharing a lane stops its live feed; snapshots already taken stay
  until deleted.
- Secrets and the terminal are never shareable at any level.

### 4. Context lives on the hub, and agents ask for it by name

Owner: "Get our CI guide and design X, or what did we decide on Y: so it is always there on the server in an
accessible way for agents."

**Layers.** Context sits at four levels, each shared with whoever can see that level:

| Layer       | Holds                                         | Example                                          |
| ----------- | --------------------------------------------- | ------------------------------------------------ |
| **Team**    | How the team works                            | CI guide, brand voice, standard stack, who's who |
| **Space**   | One client or product                         | Acme's goals, contacts, constraints              |
| **Project** | One repo, beyond what the repo itself records | Why it is built this way, environments, traps    |
| **Lane**    | One piece of work                             | The brief, review comments, teammates' additions |

**Items.** Three kinds, each with a title, author, date, layer and version history:

- **Docs**: guides, briefs, research, notes (markdown; a pinned shared result counts).
- **Decisions**: a question, the answer, who decided, when, and what it replaced. "What did we decide on Y"
  is a lookup, not a search through chat.
- **Links**: to anything outside, with a line on why it matters.

An item can be marked out of date; it stays readable but stops being offered to agents.

**Agents pull, by name or by question.** `hub_context` takes a name ("our CI guide"), a question ("what did we
decide on order ids?") or a layer, and returns the matching items with their source, newest version first, from
every layer the lane can see, narrowest first. At start a lane gets only a short index of what exists (titles,
one line each, pinned items in full), so the prompt stays small and the agent fetches what the task needs. The
repo's own `CLAUDE.md` and docs still win on the code; hub context covers what does not belong in a repo.
Personal memory stays on the person's machine.

**Agents propose; each space chooses who accepts.** `hub_remember` offers a doc or a decision. Each space sets
`agentProposals: 'review' | 'auto'` (default `review`): under review a member accepts, edits or drops it from the
space's queue; under auto it lands at once, marked as written by the agent, and can be reverted. People write and
edit context directly, on the web or from Styx. On a shared lane, a teammate's addition to the lane context
reaches that lane's agent per the lane owner's choice: at once, or after the owner accepts it.

**Every item reaches an agent with its source** ("Thandi's decision, 12 Nov"), under the same rule as section 8:
it informs the work, it never grants anything. Access still goes through grants and approvals.

### 5. Sign-in: Google Workspace, restricted by team

The hub's own API is the authorization server (as in ADR-0026, and with the same device flow for the desktop app).
For now it federates only to Google, and a team's sign-in rule is a Workspace domain: `launchsite.co.za` for the
first team. Guests and other providers (the Styx account's GitHub sign-in, other domains) are later server changes,
not app releases. Hub tokens live in the keychain (`styx:v1:hub:<team>:oauth` / `:refresh`), never in SQLite,
IPC or the renderer.

**As built (owner request 2026-11-13, "make the sign in password and email based for now"; discrepancy row
174):** email and password, with invite links instead of Google. Nobody signs themselves up: a team admin invites
an address on the team's domain (web Members page, or `POST /v1/teams/:id/invites`) and sends the person the
one-time link it returns, where they set their own password (seven days, single use; it doubles as a reset). The
operator makes the first admin's link with `POST /tasks/invite`, guarded by the deployment's sweep token. Without
invites anyone could claim any address on the domain, admins' included, since the hub sends no email to prove
ownership. Passwords are scrypt-hashed in a column the app's database role is not granted; sign-in is limited to
10 tries per email per 15 minutes, and a wrong password and an unknown address get the same words and the same
cost. The desktop device flow is unchanged for Styx: the page it opens takes the code, the email and the
password together. Google returns as a second way in when a team wants it.

### 6. Two-way, from main only

Styx main holds the connection to each hub; the renderer never talks to the network (ADR-0006). Writes are HTTPS
requests; changes come back as seq-numbered events per space, so a reconnect resumes from the last seen number.
Events carry ids, never content: the client reads what changed through the normal routes, which check access
again. Phase 1 delivers events by long-poll (`GET /v1/spaces/:id/events?after=<seq>&wait=25`), which runs on Cloud
Run with no extra infrastructure; a WebSocket or Postgres `LISTEN` replaces it when a space has more than a few
dozen clients, without changing the event shape. Offline is a state, not an error: posts
queue locally (bounded) and send on reconnect.

### 7. What agents get

New `styx mcp` tools, each requiring the hub grant:

| Tool                   | Does                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `hub_read`             | Threads, notes and artifacts in the lane's space, newest first, paged    |
| `hub_post`             | A message to a thread, a teammate, or another lane anywhere in the space |
| `hub_share`            | Upload a file from the worktree as an artifact; returns its id           |
| `hub_link`             | A signed link to an artifact: expiry, space-only or anyone-with-link     |
| `hub_context`          | Context by name, question or layer: docs, decisions, links (section 4)   |
| `hub_remember`         | Propose a doc or decision; lands per the space's `agentProposals`        |
| `hub_request_approval` | Ask the team to approve an action on a team-owned target                 |
| `hub_connector`        | Call a connector the space has enabled (section 10)                      |

Phase 1 keeps `list_sessions` and `send_message` local; teammates' shared lanes (task, branch, machine, owner)
come from `hub_read`, and messages travel through threads. A reply in a thread a lane posted in comes back into
that lane's chat, framed as section 8 says. A lane not shared cannot post; the hub tools answer that it is not
shared. The one-line index of a lane's context is what `hub_context` returns with no query, fetched when the agent
asks rather than pushed into every lane's first prompt.

### 8. Hub content is information, never instruction

Everything that arrives from the hub reaches an agent wrapped as untrusted input from a named person or lane, the
same rule as `<peer-message>` today. An agent never acts on it without its own person's go-ahead. One injected
message must not be able to steer a team's agents.

Everything an agent sends passes `redact()` / `redactArgv()` before it leaves the machine.

### 9. Shared approvals cover team-owned targets only

A target can be **personal** (today's targets: your keychain, your approvals) or **team-owned** (registered in a
space). Only team-owned targets take shared approvals. The flow:

1. An agent asks for access to a team target; the request goes to the hub with its scope and reason.
2. Any space member with the `owner` role (or a role the space names) approves it on the web or in their own Styx.
   Prod ∧ write/deploy/delete needs a passkey (WebAuthn user verification) on the approver's device: the web
   equivalent of Touch ID (ADR-0029).
3. The hub signs the decision (Ed25519, key in Cloud KMS). The requester's Styx verifies the signature, the
   approver, the scope and the expiry, then issues the credential locally and audits it.

The hub never holds the credentials of a person's targets. A team-owned target's credential is held by the team
(a service account in Secret Manager) and minted per grant, short-lived and scoped, exactly as a provider does
locally today.

### 10. Connectors live on the server

Slack, Linear, GitHub, Notion and the like are enabled per space with OAuth; tokens live in Secret Manager, and the
hub calls the external API on the agent's behalf. This is the one place a Styx-controlled service holds a
third-party secret. It is acceptable because connectors are the team's shared tools rather than a person's
targets, and every call goes into the hub's audit log with the agent, lane, person and space.

### 11. Two audit logs

The hub keeps its own append-only, hash-chained `audit_entries` (same shape as the desktop's): every post, share,
link, approval and connector call. Each Styx keeps its local log; a hub action from a lane is audited in both.

### 12. Where it runs

Launchsite hosts it in the GCP project `launchsite-digital-web`:

- **Hub API** and **hub web**: two Cloud Run services (web is Next.js on the same tokens as the app).
- **Postgres** on Cloud SQL, with row-level security.
- **Cloud Storage** for artifacts; **Secret Manager** for connector and team-target secrets; **Cloud KMS** for the
  approval signing key.

The server is closed source and lives in the private repo next to the accounts service. The desktop client (the
`hub` provider, the broker tools, the screens) is open source. `STYX_HUB` points a fork or a self-hosted team at
its own hub, as `STYX_API` does for accounts.

## Phases

1. **Spaces, messages and context.** Teams, spaces, members, threads; context docs and decisions with
   `hub_context` and `hub_remember` and the proposal queue; the WebSocket; the `hub` provider; `hub_read`,
   `hub_post`, widened `list_sessions` / `send_message`; the Share action for lanes at _status_; the web UI to read
   and post.
2. **Shared results and review.** Artifacts, builds, data and diffs as items with versions, comments and a verdict
   back into the lane; links; lane and project shares at _status + results_; share rules.
3. **Everything, live** for lanes, behind a per-team switch.
4. **Shared approvals** on team-owned targets.
5. **Connectors.**

Each phase ships on its own and gets its discrepancy row.

## Alternatives considered

- **Peer-to-peer between Styx instances.** No server to run, but there is no web interface, nothing to hold
  artifacts or connectors, and machines that are asleep miss everything. Rejected.
- **Firestore, like the accounts service.** One less database to run, but partition enforcement would live in
  security rules rather than in the database's own row-level security, and the data is relational (team → space →
  project → thread). Postgres wins for a multi-tenant store.
- **Build on Slack or Discord.** Fast to start, but partitions, approvals and artifacts would bend to someone
  else's model, and the agent tools would depend on a third-party API's rate limits. A Slack connector covers the
  real need: people who live in Slack can see the hub's threads there.
- **Let the hub hold every target's credentials.** Simplest for shared approvals, but one breach would reach every
  team's cloud. Rejected: only team-owned targets are held, and only by the team.

## Consequences

- Styx gains a network service it depends on for team features; the app stays fully usable without it.
- Launchsite operates a multi-tenant service: uptime, backups, tenant isolation and cost belong to Launchsite.
- Shared approvals add a second approval path; the grant machine gains a `remote-approved` origin (a
  `/state-machine-change`), and its tests cover a forged, expired or wrong-scope decision.
- Prompt-injection risk grows with the number of agents that can write to a space. Section 6 is the mitigation,
  and it is not complete: a space member can still talk an agent into something its person then approves.

## Open

- Pricing and seat model for teams beyond Launchsite.
- Data retention and export per team.
- How far redaction can be trusted for "everything, live": tool output can hold secrets `redact()` does not recognise. Until that is answered it may ship behind a per-team switch.
