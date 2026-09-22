# ADR-0026 — A Styx account: sign in with GitHub or Google

**Status:** accepted (2026-09-22) · **Owner request:** "now I think we need to add an account to styx",
then "continue with github and google please".

## Context

Styx has no notion of the person using it. It knows which Claude or Codex login each CLI is on
(`discovery.clis[].account`, ADR-0018) and which Vercel or GitHub account each deploy target belongs to, but
nothing about the owner of the machine. Three things want one:

- **Licensing.** Styx is a product. A paid tier needs an identity to attach a seat to.
- **Identity.** Commits Styx makes on the user's behalf fall back to `Styx <styx@localhost>` when git has no
  global `user.name` / `user.email` (`git.ts` `commit`, `asUserOrStyx`). That is a poor commit author.
- **Continuity.** Settings, the project list and per-machine state live only on this machine. Moving to a
  second machine starts from nothing.

The app is local-first and its security invariants are strict: secrets only in the OS keychain behind a
`credentialRef`, the renderer never touches the network, every mutation is a named command. An account must not
weaken any of that.

## Decision

### 1. The account is additive, never a gate

Styx works fully signed out, forever. No feature in the app today is withheld from a signed-out user, and the
sign-in surface is one pane in Settings. A developer tool that stops working on a plane, or when an auth server
is down, is not worth shipping. Anything paid that arrives later gates _that_ feature, not the app.

### 2. Federated identity: GitHub and Google, never a password

Styx's own API is the authorization server; it federates upstream to GitHub and Google. The desktop app never
sees a password, never sees a provider client secret, and never talks to GitHub or Google for authentication —
only to the Styx API. Adding a third provider later is a server change, not an app release.

Why not run our own email + password accounts: it needs password storage, reset email, deliverability and a
breach surface, for no gain. Every Styx user already has a GitHub account.

### 3. Device authorisation flow (RFC 8628)

The app asks the API for a device code, shows the user a short code, opens the browser at the verification page,
and polls until the person finishes. Chosen over a loopback redirect (RFC 8252) because:

- No local HTTP server is opened, so nothing listens on a port on the developer's machine.
- It works when the browser is on a different machine, or the app is on a remote desktop.
- It is the same shape as the GitHub device flow the app already runs for targets
  (`providers/github.ts` `deviceFlow`), so the polling, back-off and cancellation rules are known.

The cost is a code the user copies. That is acceptable once, at sign-in.

### 4. Tokens live in the keychain; the account row is public

| What                                              | Where                                                  | Why                                                              |
| ------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| access token, refresh token                       | OS keychain, `styx:v1:styx:account:oauth` / `:refresh` | The existing invariant: secrets only in the vault                |
| account (id, email, name, avatar, provider, plan) | `ui_state` under `account`                             | Not a secret; needs to survive a restart and be readable offline |
| sign-in progress (user code, verification URI)    | memory only                                            | Lives for one flow; never written anywhere                       |

No token ever reaches SQLite, a log line, an IPC payload, the renderer store, or a fixture. The renderer sees
`AccountState` and nothing else. The access token is short-lived and refreshed in main; a refresh that fails
with 401 signs the user out, and one that fails for any other reason (offline, 500) keeps the session and marks
it stale.

### 5. Offline is a first-class state, not an error

A signed-in Styx that cannot reach the API keeps its cached account and shows `offline since <time>`. Only an
explicit 401 from the API, or the person pressing Sign out, ends a session. This falls out of decision 1: the
app does not depend on the account, so the account not being reachable is a note, not a failure.

### 6. The account supplies git identity only as a fallback

`git.commit` already prefers the machine's own `user.name` / `user.email` and only falls back to
`Styx <styx@localhost>` when git has none. Signed in, that fallback becomes the account's name and email. A user
with git configured sees no change, which is the right default: their git config is the more specific answer.

## The API contract

The desktop app is written against this. The server lives in `apps/api` and runs on Cloud Run at
`https://styx-api-994871833762.us-central1.run.app` (project `styx-api-20260922`, Firestore behind it);
`STYX_API` overrides the base URL for development and tests, so nothing in CI touches the network.

Cloud Run rather than Cloudflare Workers because the owner's deploy target is GCP. The handlers do not know
either way: `handle()` takes a `Store` and a config, so the platform is one file (`store-firestore.ts`,
`server.ts`) and the tests run the same code against an in-memory store.

```
POST /v1/device/code      { provider: "github" | "google", client: "styx-desktop", version }
  → 200 { deviceCode, userCode, verificationUri, interval, expiresIn }

POST /v1/device/token     { deviceCode }
  → 200 { accessToken, refreshToken, expiresIn, account }
  → 400 { error: "authorization_pending" | "slow_down" | "expired_token" | "access_denied" }

POST /v1/token/refresh    { refreshToken }
  → 200 { accessToken, refreshToken, expiresIn, account }
  → 401 { error: "invalid_grant" }        // the only response that signs a user out

GET  /v1/me               Authorization: Bearer <accessToken>
  → 200 { account }
  → 401                                    // signs out

POST /v1/signout          Authorization: Bearer <accessToken>
  → 204                                    // best effort; local state is cleared either way

account = { id, email, name, avatarUrl, provider, plan: "free"|"pro"|"team", planUntil }
```

## Consequences

- The app gains its first outbound identity. `STYX_API` is the only host it talks to for the account, and that
  request carries the access token and nothing about the user's projects, code or agents.
- Sync is **not** part of this. The account exists and is trusted; what it carries across machines is a separate
  decision, deliberately deferred so the identity layer can ship and be lived with first.
- Onboarding is unchanged: a new user is not asked to sign in before working. The pane in Settings is the
  entry point, and the empty state says what an account is for.
- Nothing in the app reads `plan` yet. It is surfaced so the licence exists before anything charges for it.
