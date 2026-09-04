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
- Broker connections are bound to one session after `hello`; reject any `sessionId` mismatch. Rate-limit `request_access` (5/min/session).
- Timers: every issued grant has expiry/idle timers; revoke cancels them and invalidates `cred_nonce`.
