---
paths:
  [
    'packages/broker/**',
    'packages/cli/**',
    'apps/desktop/src/main/services/credential-vault*',
    'apps/desktop/src/main/providers/**',
    'apps/desktop/src/main/broker/**',
    'apps/desktop/src/main/services/grant*',
    'apps/desktop/src/main/services/mfa*',
  ]
---

# Security rules

- Secrets are read from the vault only inside `ProviderAdapter.issue/test/connect`; the returned `IssuedCredential` is the only thing that leaves, and only to the broker for the requesting session.
- Log lines must pass through `redact()`; never log env bundles, tokens, keys, or `credentialRef` values with secrets.
- `requireMfa` is recomputed in `GrantService.approve` from DB rows; prod ∧ {write,deploy,delete} forces it regardless of policies.
- `audit_entries` is never updated or deleted; use `AuditService.append` only.
- Broker connections are bound to one session after `hello` (a second `hello` drops the connection); reject any `sessionId` mismatch; persistent grants are visible only within the target's project. Rate-limit grant-creating calls (`request_access` + request-opening `exec_authorize`, 5/min/session) and `ask_user` (30/min/session).
- Anything an agent supplies that gets persisted (argv, reasons, notes, ask prompts, transcript text, pty logs) passes through `redact()` / `redactArgv()` first; audit rows are redacted before hashing.
- Scope heuristics fail closed: unknown verbs, shell metacharacters and file-transfer tools classify as `write`; providers whose credential is not narrowed per grant (`issuesScoped` absent/false) force MFA on prod for every scope, including auto policies.
- Timers: every issued grant has expiry/idle timers; revoke cancels them, drops the in-memory credential bundle and calls `adapter.revoke` (a no-op for GitHub/Vercel/Supabase: the stored token stays valid upstream, Styx only stops delivering it). There is no `cred_nonce`: replay protection is the grant row state re-checked on every broker call plus the session-bound connection.
