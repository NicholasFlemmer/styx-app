---
name: provider-adapter
description: Add or modify a target provider (vercel, aws, gcp, supabase, github, ssh) - auth flow, token scoping/minting, test-connection, health check, CLI wrapper shim, fixtures.
argument-hint: '<provider>'
allowed-tools: Read, Grep, Edit, Write, Bash(pnpm:*), WebFetch
---

# Provider adapter: $ARGUMENTS

1. Implement `ProviderAdapter` in `apps/desktop/src/main/providers/$0.ts`: `connect()`, `test()`, `issue(grant, target)`, `revoke(issued)`, `scopeOfCommand(argv)`.
2. Secrets go through `CredentialVault` only; the adapter returns a `credentialRef` + non-secret `config`.
3. Document the scope matrix (read/write/deploy/delete → provider permissions) in the file header; note whether tokens are truly scoped (`scoped: true|false`).
4. Wrapper shim: `packages/cli/src/wrappers/$0.ts` maps argv → scopes and calls `exec_authorize`.
5. Fixtures: fake credentials clearly marked `FIXTURE`; tests use an HTTP mock; never call real providers in tests.
6. Health check → `targets.health='expired'` → banner copy from `@styx/core/copy` (`errors.authExpired`).
7. Run the `security-reviewer` subagent.
