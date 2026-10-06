# Adding a deploy target provider

A target in Styx is a place an agent can change things outside the repo: a Vercel project, an AWS account, a GCP
project, a Supabase database, a GitHub repo, or an SSH host. Each target belongs to a project and has a provider,
an environment (`prod`, `staging`, `preview` or `scm`), a policy, and a `credentialRef` that points at a secret in the
OS keychain. Agents never hold the stored credential up front. When an agent runs the provider's CLI (say
`vercel deploy --prod`), a Styx shim catches the call and works out what it needs (`read`, `write`, `deploy` or
`delete`). Styx then asks the user, with OS authentication for prod writes (Touch ID or the Mac password, Windows Hello, polkit on Linux), issues a short-lived credential
for that grant only, and audits every step. When you add a provider, users can connect it from the Connect target
modal (preferably by reusing the login its own CLI already holds), and agents get gated, audited access to it.

This guide follows the current code. Where the design docs or the `provider-adapter` skill disagree with it, the code
wins.

## How it fits together

Data flows through these parts in this order.

1. **The name.** `providerSchema` and `PROVIDER_LABEL` in
   [`packages/core/src/model/common.ts`](../../packages/core/src/model/common.ts). Targets, policies, IPC commands and
   `.styx/project.json` all derive from this enum.
2. **The adapter.** A class implementing `ProviderAdapter` from
   [`apps/desktop/src/main/providers/types.ts`](../../apps/desktop/src/main/providers/types.ts), one file per
   provider in [`apps/desktop/src/main/providers/`](../../apps/desktop/src/main/providers/). It gets `AdapterDeps`:
   the credential vault, `fetch`, a clock, and a `CliRunner`
   ([`cli-runner.ts`](../../apps/desktop/src/main/providers/cli-runner.ts)) that runs provider CLIs on the login-shell
   `PATH` and never logs their output. Shared helpers for the "use the CLI's own login" mode are in
   [`cli-auth.ts`](../../apps/desktop/src/main/providers/cli-auth.ts). `ProviderRegistry` in
   [`providers/index.ts`](../../apps/desktop/src/main/providers/index.ts) holds one instance per provider and maps
   shim tool names to adapters (`forTool`). The registry is built in
   [`apps/desktop/src/main/container.ts`](../../apps/desktop/src/main/container.ts).
3. **Connect.** The renderer's
   [`ConnectModal.tsx`](../../apps/desktop/src/renderer/features/modals/ConnectModal.tsx) shows the provider grid
   (`PROVIDERS` in [`modals.ts`](../../apps/desktop/src/renderer/features/modals/modals.ts)). The primary path calls
   `target.connect.cliStatus` → `adapter.cliStatus()`, `target.connect.cliLogin` → `adapter.cliLoginCommand()` (run in
   a terminal the user can see), and `target.connect.cliSave` → `adapter.connect({ method: 'cli', … })`. Under
   Advanced, `target.connect.start` / `saveToken` / `saveKey` / `saveSsh` lead to `adapter.connect()` with a pasted
   secret. The commands are declared in [`packages/core/src/ipc/contract.ts`](../../packages/core/src/ipc/contract.ts),
   handled in [`apps/desktop/src/main/ipc/commands/target.ts`](../../apps/desktop/src/main/ipc/commands/target.ts), and
   carried out by `TargetService` in
   [`target-service.ts`](../../apps/desktop/src/main/services/target-service.ts). `connect()` writes any secret to the
   vault and returns only `{ credentialRef, config, label }`.
4. **Health.** `RefreshScheduler` ([`refresh-scheduler.ts`](../../apps/desktop/src/main/services/refresh-scheduler.ts))
   calls `TargetService.checkHealth()`, which calls `adapter.health()`. `expired: true` marks the target expired and
   raises the auth-expired banner with a Reconnect action.
5. **The agent runs the CLI.** `writeShims()` in
   [`shim-service.ts`](../../apps/desktop/src/main/services/shim-service.ts) writes a script for each name in
   `SHIM_TOOLS` into `<userData>/bin`, which is first on every agent's `PATH`. The script runs `styx wrap <tool> …`
   ([`packages/cli/src/wrap.ts`](../../packages/cli/src/wrap.ts)), which calls the broker's `exec_authorize`.
6. **Authorise.** The broker host ([`apps/desktop/src/main/broker/host.ts`](../../apps/desktop/src/main/broker/host.ts))
   finds the adapter with `providers.forTool(tool)` and classifies the call with `adapter.scopeOfCommand(argv, tool)`.
   It picks the project's target for that provider and either reuses a live grant that covers the scopes or opens a
   request with `GrantService.request()`. Agents can also ask directly through the MCP tools `request_access` and
   `get_credential` ([`packages/broker/src/mcp-stdio.ts`](../../packages/broker/src/mcp-stdio.ts)).
7. **Decide.** `GrantService` in [`grant-service.ts`](../../apps/desktop/src/main/services/grant-service.ts) runs the
   pure policy engine (`evaluatePolicies()` in [`packages/core/src/policy/engine.ts`](../../packages/core/src/policy/engine.ts))
   and the grant state machine ([`packages/core/src/machines/grant.ts`](../../packages/core/src/machines/grant.ts)).
   If the user has to decide, the grant sheet opens
   ([`grant-sheet.ts`](../../apps/desktop/src/renderer/features/grant-sheet/grant-sheet.ts)). `approve()` recomputes
   `requireMfa` in main and asks the OS for biometric verification when needed.
8. **Issue.** `GrantService` calls `adapter.issue(grant, target)`. The adapter returns an `IssuedCredential`: env vars
   (or an SSH agent socket), an expiry, and whether it is truly `scoped`. The broker sends the env back to the shim,
   which runs the real CLI with it and reports the exit code (`exec_report`). Every request, decision, use and revoke
   is written to the append-only audit log by `GrantService` and the host. Adapters never write audit rows.
9. **Expire and revoke.** Grant timers (duration, 1 h idle, session end) and manual revokes call
   `adapter.revoke(issued)`.
10. **Deploy button (optional).** `DeployService` ([`deploy-service.ts`](../../apps/desktop/src/main/services/deploy-service.ts))
    runs either the target's saved `config.deployCommand` or `adapter.deployCommand()`, under a grant.
    [`deploy-detect.ts`](../../apps/desktop/src/main/services/deploy-detect.ts) suggests a command from the repo.

Design background: [ADR-0001](../adr/0001-grant-transport-local-broker.md) (the local broker) and
[ADR-0007](../adr/0007-secrets-keychain-only.md) (keychain only).

## Worked example: Supabase

Supabase is the example because it is the smallest adapter that implements every required method plus the CLI login
mode. It uses one bearer token, has no per-grant minting and no deploy verb, and its scope classifier is short. Vercel
is the same shape with one extra: a built-in `deployCommand`.

### 1. Name and labels

```ts
export const providerSchema = z.enum(['vercel', 'aws', 'gcp', 'supabase', 'github', 'ssh']);
```

`PROVIDER_LABEL.supabase` and `copy.providers.supabase` are both `'Supabase'`.

### 2. The adapter class

[`supabase.ts`](../../apps/desktop/src/main/providers/supabase.ts) starts with the static facts:

```ts
export class SupabaseAdapter implements ProviderAdapter {
  readonly provider = 'supabase' as const;
  readonly authMethod = 'oauth' as const;
  readonly tools = ['supabase'];
  constructor(private readonly deps: AdapterDeps) {}
```

`tools` lists the binaries this provider owns. The broker uses it to route `styx wrap supabase …` here.

### 3. Connect

The Advanced path checks the pasted token against the API, writes it to the vault, and returns a reference:

```ts
const projects = await this.projects(input.token.trim());
const ref = makeCredentialRef('supabase', targetId, 'oauth');
await this.deps.vault.set(ref, JSON.stringify({ token: input.token.trim() }));
```

The returned `config` holds only non-secret settings (the project `ref`). The token never leaves the vault.

The CLI path (`connectCli`) stores no secret at all. The vault entry only names the account:

```ts
const ref = makeCredentialRef('supabase', targetId, 'cli');
const account = input.account.trim() || 'cli';
await this.deps.vault.set(ref, JSON.stringify({ kind: 'cli', account }));
```

At use time, `cliToken()` reads the token the `supabase` CLI keeps (`~/.supabase/access-token`, or the CLI's own OS
keyring entry through `deps.cli.readKeychain`) and throws `CliAuthError(…, true)` when the CLI is logged out.
`readCliEntry()` from `cli-auth.ts` tells the two modes apart by the `:cli` suffix on the `credentialRef`.

`cliStatus()` reports whether the binary is installed, its version and its accounts, using `cliInstall()` and
`semver()`. `cliLoginCommand()` returns `{ bin: 'supabase', args: ['login'] }`, which Styx runs in a visible terminal.

### 4. Test and health

`test()` returns `{ ok: true, identity }` or `{ ok: false, error }`. `health()` separates "the login is gone" from
"the network blipped": in CLI mode a `CliAuthError` carries `expired`, and in token mode `testToHealth()` treats a
401/403 as expired. Only an expiry raises the Reconnect banner.

### 5. Issue and revoke

Supabase has no API for minting a narrower token, so `issue()` hands over the stored token as env and says so:

```ts
const token = await this.token(target);
const env: Record<string, string> = { SUPABASE_ACCESS_TOKEN: token };
if (typeof target.config['ref'] === 'string') env['SUPABASE_PROJECT_REF'] = target.config['ref'];
return { kind: 'env', env, expiresAt: grant.expiresAt, scoped: false };
```

`scoped: false`, and no `issuesScoped()` method, is the honest answer. It makes `GrantService` require biometric
verification for any grant on a prod Supabase target, even "read", because the agent gets the whole token. Adapters
that can mint narrower credentials implement `issuesScoped()`: AWS (STS session policies) and GCP (for
read-only grants). `revoke()` is empty because Supabase issued nothing new. An adapter that mints a credential should
revoke it there when the provider allows it, as GCP does.

### 6. Scope classification

`scopeOfCommand(argv)` maps an invocation to scopes. It reads only the command words (`commandHead()` skips leading
flags and stops at the first flag), checks the most dangerous classes first, and treats anything it does not know as
a write:

```ts
if (cmd === 'functions' && sub === 'deploy') return ['deploy'];
// …
return ['write']; // unknown verbs fail closed
```

The tests in [`providers.test.ts`](../../apps/desktop/src/main/providers/providers.test.ts) include a "scope
classification fails closed (M2)" block that every provider is held to.

If the CLI makes the environment knowable from the command, also implement `envOfCommand(argv, tool)`: return
`'non-prod'` only for commands that provably can't touch production (Vercel: a deploy without `--prod`, an `env`
command naming `preview`, a read), `'prod'` when it says production, and `null` otherwise. When a project has a prod
and a non-prod target for your provider, `null` is judged against prod (`BrokerHost.pickTarget`), so leaving the
method out is safe; returning `'non-prod'` too eagerly lets a staging target's policy decide a production command.

### 7. Registration, shim and the rest

- `new SupabaseAdapter(deps)` is in the `ProviderRegistry` list in `providers/index.ts`.
- `'supabase'` is in `SHIM_TOOLS` in `shim-service.ts`, so agents' `supabase` calls go through `styx wrap`.
- `SUPABASE_ACCESS_TOKEN` is in `STRIPPED_ENV` in `cli-runner.ts`, so a token in Styx's own environment never
  reaches an agent or a CLI child.
- `sbp_…` tokens are a pattern in `SECRET_SHAPES` in
  [`logger.ts`](../../apps/desktop/src/main/services/logger.ts), so they are redacted from logs, audit detail and
  terminal logs.
- The renderer knows Supabase's grantable scopes (`PROVIDER_SCOPES` in `grant-sheet.ts`), its kind tag, its CLI
  name (`CLI_OF` in `modals.ts`), and its token page (`TOKEN_PAGES` in `target-service.ts`).
- [`deploy-detect.ts`](../../apps/desktop/src/main/services/deploy-detect.ts) suggests `supabase db push` and
  `copy.deploy.placeholders.supabase` is the placeholder for a custom deploy command.

## Adding yours

Below, `netlify` stands for your provider id. Lowercase, no spaces.

Before you start, check that the provider has a CLI that agents already use. The shim model gates CLI calls; a
provider reached only through raw HTTP gets nothing from the shim and must rely on `request_access` and
`get_credential`. Also find out whether the provider can mint short-lived or narrower tokens. That decides `scoped`.

The compiler finds some of these places: anything typed `Record<Provider, …>` fails `pnpm typecheck` until you add
the key. The plain arrays, the second `Provider` type in the adapter folder, SQL, regexes and prose do not. Work
through the whole list.

### Required: the provider exists and is gated

1. **Core enum and label.** Add `'netlify'` to `providerSchema` and `PROVIDER_LABEL` in
   [`packages/core/src/model/common.ts`](../../packages/core/src/model/common.ts).
2. **The adapter's own `Provider` type.** `providers/types.ts` declares its own `Provider` union. Add the id there
   too.
3. **Database.** `targets.provider` has a SQL `CHECK`. Add the id to the `enum` in
   [`apps/desktop/src/main/db/schema.ts`](../../apps/desktop/src/main/db/schema.ts), and write a new migration that
   rebuilds `targets` the way
   [`0002_auth_method_cli.sql`](../../apps/desktop/src/main/db/migrations/0002_auth_method_cli.sql) does, with the
   current column list. See [`.claude/skills/db-migration/SKILL.md`](../../.claude/skills/db-migration/SKILL.md).
4. **The adapter.** Create `apps/desktop/src/main/providers/netlify.ts` with a class implementing `ProviderAdapter`:
   - Header comment: the auth modes, which env vars `issue()` sets, whether the credential is scoped, and how
     read/write/deploy/delete map to provider permissions.
   - `provider`, `authMethod` (`'oauth'` for token paste, `'key'`, or `'ssh'`), and `tools` (every binary name the
     shim should own).
   - `connect(input, targetId)`: handle `method: 'cli'` (store only `{ kind: 'cli', account }`) and your Advanced
     method. Verify the credential against the provider before storing it. Store secrets only with
     `deps.vault.set(makeCredentialRef('netlify', targetId, …), …)`. Return non-secret `config` and a `label`.
   - `test()`, and `health()` that sets `expired` only for real auth failures (use `CliAuthError`, `cliFailure()`
     and `testToHealth()` from `cli-auth.ts`).
   - `issue(grant, target)`: mint the narrowest, shortest-lived credential the provider supports, capped with
     `expiryFor()`. Set `scoped` honestly. If you can mint narrower credentials, implement `issuesScoped()`.
   - `revoke(issued)`: revoke anything you minted. Keep a `handle` in the issued credential if you need one.
   - `scopeOfCommand(argv, tool)`: build on `commandHead()`, `isHelp()`, `hasVerb()` and `shortFlags()` from
     `types.ts`. Check delete, then deploy, then write, then an explicit read list. Return `['write']` for anything
     unknown. Never classify by flag values.
   - CLI mode: `cliStatus()` and `cliLoginCommand()`. Read the CLI's own token store read-only and on every use;
     never copy it into the vault. Put any path helper next to `vercelAuthPaths()` in `cli-auth.ts`.
   - Optional: `deployCommand(target)` if the provider has one obvious deploy verb.
5. **Registry.** Add `new NetlifyAdapter(deps)` to the list in
   [`providers/index.ts`](../../apps/desktop/src/main/providers/index.ts).
6. **Shim.** Add each tool name to `SHIM_TOOLS` in
   [`shim-service.ts`](../../apps/desktop/src/main/services/shim-service.ts). Add them to `CLOUD_CLI_BY_PATH` in
   [`stream-runner.ts`](../../apps/desktop/src/main/services/stream-runner.ts), which notices an agent calling the
   real binary by full path to skip the shim.
7. **Environment hygiene.** Add the provider's token env vars to `STRIPPED_ENV` in
   [`cli-runner.ts`](../../apps/desktop/src/main/providers/cli-runner.ts). If the CLI prompts or prints update
   notices, add a quiet setting to `QUIET_ENV`.
8. **Redaction.** If the provider's tokens have a recognisable prefix, add it to `SECRET_SHAPES` in
   [`logger.ts`](../../apps/desktop/src/main/services/logger.ts). If its CLI takes a secret through a flag that is not
   in `SECRET_FLAGS`, add that flag.
9. **Connect flow.** In [`target-service.ts`](../../apps/desktop/src/main/services/target-service.ts): `AUTH_METHOD`
   and, for token paste, `TOKEN_PAGES`. In [`modals.ts`](../../apps/desktop/src/renderer/features/modals/modals.ts):
   `PROVIDERS` (the grid order; it also feeds onboarding), `CLI_OF`, and `methodOf()` (it repeats the auth method
   rule). Add the id to `PROVIDERS` in
   [`PolicyRuleModal.tsx`](../../apps/desktop/src/renderer/features/modals/PolicyRuleModal.tsx).
10. **Grant sheet.** Add `PROVIDER_SCOPES` (the scopes a user can grant) and `PROVIDER_KIND` (the tag next to the
    env) in [`grant-sheet.ts`](../../apps/desktop/src/renderer/features/grant-sheet/grant-sheet.ts).
11. **Copy.** In [`packages/core/src/copy.ts`](../../packages/core/src/copy.ts): `providers.netlify` and
    `deploy.placeholders.netlify`. Add the CLI to the tool lists in `agentPrompt.shims` and `agentPrompt.learnDeploy`.
    These tell agents which commands are wrapped.
12. **MCP tool description.** Add the provider and its CLI to the `request_access` description in
    [`packages/broker/src/mcp-stdio.ts`](../../packages/broker/src/mcp-stdio.ts). The broker protocol types
    `provider` as a string, so nothing else changes there.
13. **Fixture credentials.** `fixtureSecretFor()` in
    [`apps/desktop/src/main/db/seed-vault.ts`](../../apps/desktop/src/main/db/seed-vault.ts) gives fixture targets a
    fake `{ token: 'FIXTURE-…' }`. Add a `case` if your `connect()` stores a different shape. Every fake value must
    say `FIXTURE`.

### Optional

14. **Deploy.** For a built-in verb, implement `deployCommand()` and add the id to `DEPLOYABLE_PROVIDERS` in
    [`packages/core/src/selectors/palette.ts`](../../packages/core/src/selectors/palette.ts). For suggestions read
    from the repo, add a `case` to `detectDeployCommands()` in `deploy-detect.ts`. Its suggestions must never run
    anything that changes state.
15. **Demo fixture.** Add a target to `demoAcmeTargets()` in
    [`packages/core/src/fixtures/demo.ts`](../../packages/core/src/fixtures/demo.ts), using the same `config` keys your
    adapter reads.
16. **File tree.** If the provider's CLI writes a cache folder into repos, add it to `TREE_IGNORED_DIRS` in
    [`packages/core/src/model/project.ts`](../../packages/core/src/model/project.ts) (`.netlify` is already there).
17. **Icons and colours.** There are none per provider. Targets are named in text everywhere; do not add an icon set.

### Docs and website

18. **README.** "Works with", the opening lines, and the shim list in "How does an agent ask?" in
    [`README.md`](../../README.md).
19. **Website.** `targets` in [`apps/website/components/Compat.tsx`](../../apps/website/components/Compat.tsx),
    `deploy` in [`apps/website/lib/compare/styx.ts`](../../apps/website/lib/compare/styx.ts), and
    [`apps/website/public/llms.txt`](../../apps/website/public/llms.txt).
20. **Discrepancy log.** The provider grid now differs from the handoff prototype. Add the next numbered row to
    [`docs/handoff-discrepancies.md`](../handoff-discrepancies.md) (`| # | Where | Prototype | Spec | Resolution |`).
    Maintainers may renumber it on merge.

You do not need to add IPC commands. The `target.*` commands take `providerSchema`, and `TargetService` calls the
adapter through the registry.

## Testing it

First-time setup is in the README's "Build from source" section (`pnpm install`, `pnpm tokens:build`).

```sh
pnpm typecheck                                      # finds missing Record<Provider, …> keys
pnpm -F @styx/desktop test src/main/providers       # adapters, CLI auth, registry
pnpm -F @styx/desktop test src/main/broker          # exec_authorize, request_access, get_credential
pnpm -F @styx/desktop test src/main/services        # grants, targets, deploy, shims
pnpm -F @styx/core test                             # policy engine, selectors, copy
pnpm lint
```

Write tests in [`providers.test.ts`](../../apps/desktop/src/main/providers/providers.test.ts), or a
`netlify.test.ts` next to the adapter, with the same tools:

- `MemoryVault` from [`credential-vault.ts`](../../apps/desktop/src/main/services/credential-vault.ts) instead of
  the keychain.
- A stubbed `fetch` that answers by URL prefix (the `deps()` helper at the top of `providers.test.ts`). Never call
  the real provider.
- `FakeCliRunner` from `cli-runner.ts` for CLI mode: `.install(bin)`, `.on(bin, argsPrefix, result)`,
  `.file(path, contents)`, and `keychain` entries.

Cover at least:

- connect with each method stores exactly one vault entry, and no secret appears in `config` or `label`;
- in CLI mode, the vault entry is `{ kind: 'cli', account }` and the CLI token is read per use, not stored;
- `issue()` returns the expected env and `scoped` value, and `revoke()` undoes anything it minted;
- `scopeOfCommand()` as a table: every delete, deploy and write verb, `--help`, an unknown verb (must be `write`),
  and tricks like a read-looking word in a flag value. Add your provider to the "fails closed (M2)" block;
- `health()` returns `expired: true` for a 401 or a logged-out CLI and `expired: false` for a timeout or a missing
  binary;
- the `ProviderRegistry` test's `toHaveLength(6)` and `forTool()` expectations, updated.

End-to-end tests drive the built Electron app with Playwright (`pnpm build`, then `pnpm e2e`).
[`apps/desktop/e2e/launch.ts`](../../apps/desktop/e2e/launch.ts) puts
[`apps/desktop/e2e/fixtures/bin/`](../../apps/desktop/e2e/fixtures/bin/) first on `PATH` and starts the app with
`STYX_KEYCHAIN=memory`. Fixture targets then get fake `FIXTURE` credentials. If your test makes the app run the
provider's CLI (a `cliStatus` probe, a deploy), add a fake `fixtures/bin/netlify` Node script (executable, with a
`.cmd` twin for Windows, copied from `gh.cmd`), like the fake [`gh`](../../apps/desktop/e2e/fixtures/bin/gh). Set
`STYX_MFA=auto` in the launch env to pass the biometric step, as
[`grant-flow.spec.ts`](../../apps/desktop/e2e/grant-flow.spec.ts) does. Run one spec with
`pnpm e2e -- --grep "<test name>"`.

To try it by hand:

```sh
STYX_FIXTURE=demo STYX_KEYCHAIN=memory pnpm dev
```

This opens sample projects in a temporary database, with an in-memory keychain and scheduled health checks off.
Connect your provider from Settings › Targets with a real login: the secret stays in memory and is gone when you
quit. Then spawn a shell session in that project and run your CLI. The call should open a grant request; approving it
should run the command with the issued env, and Approvals › Audit log should show the request, grant and use. Try a
prod target to see the biometric prompt.

A good PR includes:

- the adapter with its header comment, its tests, and the migration;
- a scope table in the PR description (command → scope) and an honest note on `scoped`;
- `pnpm typecheck && pnpm lint && pnpm test` passing;
- the provider CLI version you checked against;
- screenshots of the provider grid, the connect step and a grant sheet;
- the README "Works with" line and a discrepancy-log row;
- a request for a security review. The `security-reviewer` agent in [`.claude/agents/`](../../.claude/agents/) is
  the checklist maintainers use.

## Security rules

These apply to every target. They are the reason targets exist.

- **Secrets only in the OS keychain.** Store credentials only through `CredentialVault`, behind a `credentialRef`
  made by `makeCredentialRef()`. Never put a secret in SQLite (including target `config`), logs, IPC payloads,
  renderer state, `.styx/project.json`, fixtures or the repo. Error messages reach audit detail and banners: quote
  the CLI's stderr diagnostics (`cliFailure()` does this), never its stdout, and never a response body that could
  echo a token.
- **Reuse the CLI login without copying it.** In CLI mode the vault holds only the account name. Read the CLI's token
  store read-only, on every use. Read its OS keyring entry through `CliRunner.readKeychain()` so the keychain prompt
  names Styx.
- **Short-lived, scoped credentials.** Prefer minting a credential limited to the granted scopes and the grant's
  lifetime, capped with `expiryFor()`. If the provider cannot do that, return `scoped: false` and do not implement
  `issuesScoped()`. Styx then forces biometric verification on prod for every scope. Never claim `scoped: true` for
  a credential that can do more than the grant says.
- **Fail closed.** `scopeOfCommand()` returns `['write']` for anything it does not recognise. A misclassified
  deploy or delete is a security bug, not a usability bug.
- **Biometric for prod is computed in main.** `requireMfa` comes from the policy engine, `requiresMfa()` in the grant
  machine and `GrantService.approve()`, from database rows. Do not add a code path that takes it from the renderer
  or the agent, or that issues a prod write, deploy or delete credential without going through `approve()`.
- **Everything is audited.** Request, grant, deny, use and revoke are recorded with actor, session, worktree and the
  triggering command (redacted with `redactArgv()`). You get this by going through `GrantService` and the broker.
  Never hand out a credential any other way. `audit_entries` is append-only; a revoke inserts a new row.
- **Agents get credentials only for the grant's lifetime.** Through the shim env or `get_credential`, never
  persistently, and never in the agent's launch env. SSH-style providers hand over a forwarded agent socket, never a
  key file (see [`ssh.ts`](../../apps/desktop/src/main/providers/ssh.ts) and
  [`ssh-agent.ts`](../../apps/desktop/src/main/providers/ssh-agent.ts)).
- **Inputs are hostile.** Account names travel into argv: validate them with `ACCOUNT_PATTERN`. Target `config` can
  be seeded from a committed `.styx/project.json`: only compose plain identifiers into commands, as
  `detectDeployCommands()` does with `SAFE_ID`.
- **Tests never touch real providers.** Use `MemoryVault`, a stubbed `fetch` and `FakeCliRunner`. Fixture
  credentials say `FIXTURE`.
