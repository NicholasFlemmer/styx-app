---
name: provider-adapter
description: Add or modify a target provider (vercel, aws, gcp, supabase, github, ssh, or a new one) - connect modes (CLI login, token, OAuth, keys), test and health, token issue/revoke and scoping, scope classification, shims, fixtures and tests.
argument-hint: '<provider>'
allowed-tools: Read, Grep, Edit, Write, Bash(pnpm:*), WebFetch
---

# Provider adapter: $ARGUMENTS

The full, current walkthrough is `docs/contributing/adding-a-target.md` (worked example: Supabase). Read it first and
follow its "Adding yours" checklist; this is the short version.

1. Add the id to `providerSchema` (`packages/core/src/model/common.ts`) and the second `Provider` union in
   `apps/desktop/src/main/providers/types.ts`; `targets.provider` has a SQL `CHECK`, so add a table-rebuild migration
   (`/db-migration`).
2. Implement `ProviderAdapter` in `apps/desktop/src/main/providers/$0.ts`: connect (CLI login first, then token /
   OAuth / keys under Advanced), `test`, `health`, `issue`, `revoke`, `scopeOfCommand(argv)` (fails closed: unknown
   commands are the widest scope). Register it in `providers/index.ts`.
3. Secrets go through `CredentialVault` only, behind `credentialRef`; `config` holds non-secret ids. Report `scoped`
   honestly: an unscoped prod credential needs MFA even for reads.
4. Shims are generic (`packages/cli/src/wrap.ts` + `exec_authorize`); add the CLI name to the shim tool list, the
   stripped env vars and the secret shapes the guide lists.
5. Copy and UI: provider names, connect bodies and the renderer's provider lists (see the guide's checklist).
6. Tests: `MemoryVault`, stubbed `fetch`, `FakeCliRunner`, a scope table including "fails closed", the registry
   test. Fake credentials are marked `FIXTURE`; never call real providers.
7. Run the `security-reviewer` subagent.
