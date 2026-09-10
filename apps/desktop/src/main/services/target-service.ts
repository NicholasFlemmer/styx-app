import {
  copy,
  fill,
  formatAge,
  newId,
  type AuthMethod,
  type Env,
  type Provider,
  type Target,
  type TargetPolicy,
} from '@styx/core';
import { homedir } from 'node:os';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type {
  CliCommand,
  CliStatus,
  ConnectInput,
  HealthResult,
  ProviderRegistry,
  TargetInfo,
} from '../providers';
import { ACCOUNT_PATTERN, CliAuthError, testToHealth } from '../providers/cli-auth';
import type { CliRunner } from '../providers/cli-runner';
import type { Publisher } from '../store/publisher';
import type { ActivityService } from './activity-service';
import type { AuditService } from './audit-service';
import type { CredentialVault } from './credential-vault';
import type { GrantService } from './grant-service';
import { auditContext } from './labels';
import { logger, redact } from './logger';
import type { PtyService } from './pty-service';
import type { RefreshReason } from './refresh-scheduler';
import type { TerminalService } from './terminal-service';

export interface TargetServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  audit: AuditService;
  providers: ProviderRegistry;
  vault: CredentialVault;
  grants: Pick<GrantService, 'cancelTargetGrants' | 'invalidate'>;
  activity: ActivityService;
  openExternal: (url: string) => Promise<void>;
  /** CLI login terminals (`target.connect.cliLogin`) run through the user-terminal path. */
  terminals: Pick<TerminalService, 'spawnCommand'>;
  pty: Pick<PtyService, 'on' | 'off'>;
  cli: Pick<CliRunner, 'which' | 'home'>;
}

/** Accounts travel into argv (`--profile x`, `--account x`) and audit rows: plain charset, no leading dash. */
const ACCOUNT = ACCOUNT_PATTERN;

/** Where a pasted token comes from for providers without a registered Styx OAuth app (spec: PAT/paste paths ship regardless). */
const TOKEN_PAGES: Partial<Record<Provider, string>> = {
  vercel: 'https://vercel.com/account/settings/tokens',
  supabase: 'https://supabase.com/dashboard/account/tokens',
  github: 'https://github.com/login/device',
};

const AUTH_METHOD: Record<Provider, AuthMethod> = {
  vercel: 'oauth',
  supabase: 'oauth',
  github: 'oauth',
  aws: 'key',
  gcp: 'key',
  ssh: 'ssh',
};

/** Targets + connect flows (plan §5 ProviderAdapters). Secrets go straight to the vault inside `adapter.connect`. */
/** The CLI account a target authenticates as: aws stores it as `profile`, gcp/others as `account`. */
const accountOf = (t: Target): string | null => {
  const profile = t.config['profile'];
  if (typeof profile === 'string' && profile !== '') return profile;
  const account = t.config['account'];
  if (typeof account === 'string' && account !== '') return account;
  return null;
};

export class TargetService {
  constructor(private readonly deps: TargetServiceDeps) {}

  require(id: string): Target {
    return this.deps.repos.targets.get(id) ?? fail('not-found', `target ${id} not found`);
  }

  private info(t: Target): TargetInfo {
    return {
      id: t.id,
      provider: t.provider,
      name: t.name,
      env: t.env,
      config: t.config,
      credentialRef: t.credentialRef,
    };
  }

  private upsertRow(target: Target): void {
    this.deps.repos.targets.upsert(target);
    this.deps.publisher.upsert('targets', [target.id]);
  }

  private audit(
    action: 'connected' | 'disconnected' | 'tested' | 'policy-changed',
    target: Target,
    triggeredBy: string,
    detail: Record<string, unknown> = {},
  ): void {
    const row = this.deps.audit.append({
      actorKind: 'you',
      actorLabel: 'you',
      action,
      ...auditContext(this.deps.repos, { target, projectId: target.projectId }),
      triggeredBy,
      detail,
    });
    this.deps.publisher.upsert('auditEntries', [row.id]);
    const entry = this.deps.repos.audit.get(row.id);
    if (entry) this.deps.activity.fromAudit(entry);
  }

  private placeholder(
    projectId: string,
    provider: Provider,
    env: Env,
    name: string | undefined,
    authMethod: AuthMethod = AUTH_METHOD[provider],
  ): Target {
    const existing = this.deps.repos.targets
      .byProject(projectId)
      .find((t) => t.provider === provider && t.env === env && (name === undefined || t.name === name));
    if (existing) return existing;
    const t: Target = {
      id: newId<'TargetId'>(),
      projectId: projectId as Target['projectId'],
      provider,
      name: name ?? copy.providers[provider],
      env,
      authMethod,
      policy: env === 'prod' ? 'ask-mfa' : env === 'scm' ? 'always' : 'ask',
      policySource: 'app',
      credentialRef: null,
      health: 'unconnected',
      healthCheckedAt: null,
      expiredAt: null,
      config: {},
      fromProjectFile: false,
      createdAt: this.deps.clock.now(),
    };
    this.upsertRow(t);
    return t;
  }

  /**
   * OAuth-style connect. GitHub runs the device flow in the background (progress via `connect.progress`);
   * Vercel/Supabase have no registered OAuth app yet, so the flow opens the token page and waits for a paste.
   */
  connectStart(
    projectId: string,
    provider: Provider,
    env: Env,
    name?: string,
  ): { flowId: string; authMethod: AuthMethod; browserUrl: string | null; targetId: string } {
    const target = this.placeholder(projectId, provider, env, name);
    const flowId = `flow-${newId<'FlowId'>()}`;
    const browserUrl = TOKEN_PAGES[provider] ?? null;
    if (provider === 'github') void this.runDeviceFlow(flowId, target);
    else if (browserUrl) {
      this.deps.publisher.sendEvent('connect.progress', {
        flowId,
        phase: 'waiting-browser',
        message: 'Paste the token from the browser to finish',
      });
    } else {
      this.deps.publisher.sendEvent('connect.progress', { flowId, phase: 'waiting-browser', message: null });
    }
    return { flowId, authMethod: AUTH_METHOD[provider], browserUrl, targetId: target.id };
  }

  private async runDeviceFlow(flowId: string, target: Target): Promise<void> {
    const { publisher } = this.deps;
    try {
      const r = await this.deps.providers.get('github').connect(
        {
          method: 'device',
          onCode: (code) => {
            publisher.sendEvent('connect.progress', {
              flowId,
              phase: 'waiting-browser',
              message: `${code.userCode} · ${code.verificationUri}`,
            });
            void this.deps.openExternal(code.verificationUri).catch(() => undefined);
          },
        },
        target.id,
      );
      publisher.sendEvent('connect.progress', { flowId, phase: 'testing', message: null });
      await this.finishConnect(target, r);
      publisher.sendEvent('connect.progress', { flowId, phase: 'saved', message: null });
    } catch (e) {
      logger.warn('connect: device flow failed', { flowId, error: (e as Error).message });
      publisher.sendEvent('connect.progress', { flowId, phase: 'failed', message: (e as Error).message });
    }
  }

  /** Pasted token for token-based providers (Vercel / Supabase / GitHub PAT). */
  async saveToken(targetId: string, token: string): Promise<Target> {
    const target = this.require(targetId);
    const r = await this.deps.providers
      .get(target.provider)
      .connect({ method: 'token', token, name: target.name, config: target.config }, target.id)
      .catch((e: Error) => fail('provider-error', e.message));
    return this.finishConnect(target, r);
  }

  private async finishConnect(
    target: Target,
    r: { credentialRef: string; config: Record<string, unknown>; label: string },
    authMethod: AuthMethod = target.authMethod,
  ): Promise<Target> {
    const now = this.deps.clock.now();
    // Switching modes (key → cli or back) leaves the old keychain entry orphaned unless it goes now.
    if (target.credentialRef && target.credentialRef !== r.credentialRef)
      await this.deps.vault.delete(target.credentialRef).catch(() => undefined);
    const next: Target = {
      ...target,
      authMethod,
      credentialRef: r.credentialRef,
      config: { ...target.config, ...r.config } as Target['config'],
      name: target.fromProjectFile ? target.name : target.name || r.label,
      health: 'ok',
      healthCheckedAt: now,
      expiredAt: null,
    };
    this.upsertRow(next);
    // The point of reconnecting is to replace a credential that went stale. Live grants cache their minted
    // bundle, so without this the next shim call still serves the dead one and only an app restart clears it.
    this.deps.grants.invalidate(next.id);
    this.audit('connected', next, 'connect flow', { authMethod: next.authMethod });
    return next;
  }

  async saveKey(input: {
    projectId: string;
    provider: 'aws' | 'gcp';
    name: string;
    env: Env;
    accessKey: string;
    secret: string;
    config: Record<string, unknown>;
  }): Promise<Target> {
    const target = this.placeholder(input.projectId, input.provider, input.env, input.name);
    const connect: ConnectInput =
      input.provider === 'aws'
        ? {
            method: 'key',
            accessKeyId: input.accessKey,
            secretAccessKey: input.secret,
            name: input.name,
            ...(typeof input.config['region'] === 'string' ? { region: input.config['region'] } : {}),
            ...(typeof input.config['roleArn'] === 'string' ? { roleArn: input.config['roleArn'] } : {}),
          }
        : {
            method: 'service-account',
            json: input.secret,
            ...(input.accessKey ? { projectId: input.accessKey } : {}),
          };
    const r = await this.deps.providers
      .get(input.provider)
      .connect(connect, target.id)
      .catch((e: Error) => fail('provider-error', e.message));
    return this.finishConnect(
      { ...target, config: { ...target.config, ...input.config } as Target['config'] },
      r,
    );
  }

  async saveSsh(input: {
    projectId: string;
    name: string;
    env: Env;
    host: string;
    user: string;
    keyPath: string;
  }): Promise<Target> {
    const target = this.placeholder(input.projectId, 'ssh', input.env, input.name);
    const r = await this.deps.providers
      .get('ssh')
      .connect({ method: 'ssh', host: input.host, user: input.user, keyPath: input.keyPath }, target.id)
      .catch((e: Error) => fail('provider-error', e.message));
    return this.finishConnect(target, r);
  }

  // --- CLI-first connect (plan §5: reuse the login gcloud / aws / gh / vercel / supabase already hold) --------

  /** What the provider's CLI knows right now: installed, version, accounts. Identities only; tokens never cross IPC. */
  async cliStatus(provider: Provider): Promise<CliStatus> {
    const adapter = this.deps.providers.get(provider);
    if (!adapter.cliStatus) fail('invalid-input', `${copy.providers[provider]} has no CLI login`);
    try {
      return await adapter.cliStatus();
    } catch (e) {
      logger.warn('connect: cli status failed', { provider, error: (e as Error).message });
      fail('provider-error', (e as Error).message);
    }
  }

  /**
   * Runs the CLI's own login flow (`gcloud auth login`, `aws sso login --profile x`, `gh auth login --web`,
   * `vercel login`, `supabase login`) in a pty the renderer attaches to over the `pty` channel; `connect.cliLogin`
   * reports `running` now and `exited` with the exit code when the CLI returns.
   */
  async cliLogin(projectId: string, provider: Provider, account?: string): Promise<{ terminalId: string }> {
    const adapter = this.deps.providers.get(provider);
    if (!adapter.cliLoginCommand) fail('invalid-input', `${copy.providers[provider]} has no CLI login`);
    if (account !== undefined && !ACCOUNT.test(account))
      fail('invalid-input', 'account: letters, digits, space, . _ @ + : / - only');
    const cmd: CliCommand = adapter.cliLoginCommand(account);
    const file = await this.deps.cli.which(cmd.bin);
    if (!file) fail('cli-missing', `${cmd.bin} not found on PATH`);
    const project = this.deps.repos.projects.get(projectId);
    const cwd = project?.path ?? this.deps.cli.home ?? homedir();
    const terminalId = await this.deps.terminals
      .spawnCommand({ file, args: cmd.args, cwd, ...(cmd.env ? { env: cmd.env } : {}) })
      .catch((e: Error) => fail('internal', `could not start ${cmd.bin}: ${e.message}`));
    const { publisher } = this.deps;
    const onExit = (id: string, exitCode: number) => {
      if (id !== terminalId) return;
      this.deps.pty.off('exit', onExit);
      publisher.sendEvent('connect.cliLogin', { terminalId, provider, status: 'exited', exitCode });
    };
    this.deps.pty.on('exit', onExit);
    logger.info('connect: cli login started', { provider, bin: cmd.bin, args: cmd.args, terminalId });
    publisher.sendEvent('connect.cliLogin', { terminalId, provider, status: 'running' });
    return { terminalId };
  }

  /** Saves a target bound to a CLI account (`authMethod: 'cli'`), then runs the health check to set `health`. */
  async cliSave(input: {
    projectId: string;
    provider: Provider;
    env: Env;
    name: string;
    account: string;
    config: Record<string, unknown>;
  }): Promise<Target> {
    const adapter = this.deps.providers.get(input.provider);
    if (!adapter.cliStatus) fail('invalid-input', `${copy.providers[input.provider]} has no CLI login`);
    if (!ACCOUNT.test(input.account))
      fail('invalid-input', 'account: letters, digits, space, . _ @ + : / - only');
    const target = this.placeholder(input.projectId, input.provider, input.env, input.name, 'cli');
    const r = await adapter
      .connect(
        {
          method: 'cli',
          account: input.account,
          name: input.name,
          config: { ...target.config, ...input.config },
        },
        target.id,
      )
      .catch((e: Error) => fail('provider-error', e.message));
    const saved = await this.finishConnect(
      { ...target, config: { ...target.config, ...input.config } as Target['config'] },
      r,
      'cli',
    );
    await this.checkHealth(saved, 'manual');
    // One `gcloud auth login` fixes every row bound to that account, not just the one being connected: the same
    // account is typically attached to a target per project, and they all expired together on the same lapse.
    await this.healSiblings(saved);
    return this.require(saved.id);
  }

  /** `target.refresh`: the health check now, for one target or every connected one. */
  async refresh(targetId?: string): Promise<{ ok: boolean }> {
    const list = targetId === undefined ? this.deps.repos.targets.all() : [this.require(targetId)];
    let ok = true;
    for (const t of list) {
      if (t.credentialRef === null) continue;
      await this.checkHealth(t, 'manual');
      if (this.deps.repos.targets.get(t.id)?.health !== 'ok') ok = false;
    }
    return { ok };
  }

  /**
   * Health probe (RefreshScheduler + `target.refresh`). Only a real mint failure (`expired: true`) flips the row to
   * `expired` and raises the auth-expired banner; a transient failure (CLI missing, timeout, network) keeps the
   * current health. Audit rows only on transitions so a 30-minute cadence does not flood the log.
   */
  async checkHealth(target: Target, reason: RefreshReason): Promise<void> {
    if (target.credentialRef === null) return;
    const adapter = this.deps.providers.get(target.provider);
    // No CLI to refresh and a real `ssh host true` per probe: SSH hosts are checked on demand only.
    if (!adapter.health && reason !== 'manual') return;
    let r: HealthResult;
    try {
      if (adapter.health) r = await adapter.health(this.info(target));
      else r = testToHealth(await adapter.test(this.info(target)));
    } catch (e) {
      r = { ok: false, expired: e instanceof CliAuthError ? e.expired : false, error: (e as Error).message };
    }
    const now = this.deps.clock.now();
    if (r.ok) {
      this.authStrikes.delete(target.id);
      this.upsertRow({ ...target, health: 'ok', healthCheckedAt: now, expiredAt: null });
      this.clearExpiredBanner(target);
      if (target.health === 'expired')
        this.audit('tested', target, `refresh (${reason})`, { ok: true, identity: r.identity });
      return;
    }
    if (!r.expired) {
      logger.warn('refresh: health check inconclusive', {
        targetId: target.id,
        provider: target.provider,
        error: r.error,
      });
      this.upsertRow({ ...target, healthCheckedAt: now });
      return;
    }
    // Confirm before expiring. A single failed probe is not proof a credential is gone: gcloud's reauth prompt
    // fails non-interactively, and a wake-from-sleep race fails everything at once. Expiring on the first failure
    // is what made one lapse drop several targets within seconds. A `manual` probe is the user asking directly,
    // so it answers immediately rather than making them wait out a backoff.
    const strikes = (this.authStrikes.get(target.id) ?? 0) + 1;
    if (reason !== 'manual' && strikes < TargetService.AUTH_STRIKES) {
      this.authStrikes.set(target.id, strikes);
      logger.info('refresh: auth failure, awaiting confirmation', {
        targetId: target.id,
        provider: target.provider,
        strike: strikes,
        of: TargetService.AUTH_STRIKES,
      });
      this.upsertRow({ ...target, healthCheckedAt: now });
      return;
    }
    this.authStrikes.delete(target.id);
    if (target.health !== 'expired')
      this.audit('tested', target, `refresh (${reason})`, { ok: false, error: r.error });
    this.markExpired(target, r.error);
  }

  /**
   * Consecutive auth failures per target, cleared by any success. Two strikes: the scheduler's own cadence is the
   * backoff, so a target expires on the second consecutive confirmation rather than the first blip.
   */
  private readonly authStrikes = new Map<string, number>();
  private static readonly AUTH_STRIKES = 2;

  /** GrantService could not mint through the adapter: an auth failure from the CLI expires the target right away. */
  noteIssueFailure(targetId: string, error: Error): void {
    const target = this.deps.repos.targets.get(targetId);
    if (!target || !(error instanceof CliAuthError) || !error.expired) return;
    if (target.health !== 'expired')
      this.audit('tested', target, 'grant issue', { ok: false, error: error.message });
    this.markExpired(target, error.message);
  }

  async test(targetId: string): Promise<{ ok: boolean; message: string | null }> {
    const target = this.require(targetId);
    if (target.credentialRef === null) return { ok: false, message: copy.targets.state.unconnected };
    const r = await this.deps.providers.get(target.provider).test(this.info(target));
    const now = this.deps.clock.now();
    if (r.ok) {
      this.upsertRow({ ...target, health: 'ok', healthCheckedAt: now, expiredAt: null });
      this.clearExpiredBanner(target);
    } else {
      this.markExpired(target, r.error);
    }
    this.audit('tested', target, 'settings', {
      ok: r.ok,
      ...(r.ok ? { identity: r.identity } : { error: r.error }),
    });
    return r.ok ? { ok: true, message: r.identity } : { ok: false, message: r.error };
  }

  /** Credentials rejected by the provider: health → expired, persistent banner (spec §10 errors.authExpired). */
  markExpired(target: Target, message: string | null): void {
    const now = this.deps.clock.now();
    const expiredAt = target.expiredAt ?? now;
    this.upsertRow({ ...target, health: 'expired', healthCheckedAt: now, expiredAt });
    const bannerKey = `auth-expired:${target.id}`;
    const text = fill(copy.errors.authExpired.text, { target: target.name, t: formatAge(expiredAt, now) });
    const existing = this.deps.repos.notifications.byBannerKey(bannerKey);
    const id = existing?.id ?? `banner-${bannerKey}`;
    this.deps.repos.notifications.upsert({
      id,
      kind: 'error-banner',
      sessionId: null,
      askId: null,
      projectId: target.projectId,
      title: text,
      body: redact(message ?? ''),
      meta: null,
      osDelivered: false,
      state: 'shown',
      bannerKey,
      createdAt: existing?.createdAt ?? now,
      resolvedAt: null,
    });
    this.deps.publisher.upsert('notifications', [id]);
    this.deps.publisher.sendEvent('banner.set', {
      bannerKey,
      kind: 'auth-expired',
      text,
      cta: copy.errors.authExpired.cta,
      action: { kind: 'reconnect', targetId: target.id },
      sessionId: null,
      reason: 'auth-expired',
    });
  }

  private clearExpiredBanner(target: Target): void {
    const key = `auth-expired:${target.id}`;
    const n = this.deps.repos.notifications.byBannerKey(key);
    if (!n || n.state === 'resolved') return;
    this.deps.repos.notifications.upsert({ ...n, state: 'resolved', resolvedAt: this.deps.clock.now() });
    this.deps.publisher.upsert('notifications', [n.id]);
    this.deps.publisher.sendEvent('banner.clear', { bannerKey: key });
  }

  setPolicy(targetId: string, policy: TargetPolicy): Target {
    const target = this.require(targetId);
    const next: Target = { ...target, policy, policySource: 'app' };
    this.upsertRow(next);
    this.audit('policy-changed', next, 'settings', { from: target.policy, to: policy });
    return next;
  }

  /**
   * Re-probes every other target that shares this one's provider and CLI account, so a single re-login clears all
   * of their banners instead of leaving the user to walk the Connect modal once per project.
   */
  private async healSiblings(target: Target): Promise<void> {
    const account = accountOf(target);
    if (account === null) return;
    const siblings = this.deps.repos.targets
      .all()
      .filter(
        (t) =>
          t.id !== target.id &&
          t.provider === target.provider &&
          t.health === 'expired' &&
          t.credentialRef !== null &&
          accountOf(t) === account,
      );
    for (const t of siblings) {
      this.authStrikes.delete(t.id);
      await this.checkHealth(t, 'manual').catch(() => undefined);
    }
    if (siblings.length > 0)
      logger.info('refresh: healed siblings after re-login', {
        provider: target.provider,
        count: siblings.length,
      });
  }

  async remove(targetId: string): Promise<void> {
    const target = this.require(targetId);
    this.deps.grants.cancelTargetGrants(target.id);
    if (target.credentialRef) await this.deps.vault.delete(target.credentialRef).catch(() => undefined);
    this.audit('disconnected', target, 'settings');
    const grantIds = this.deps.repos.grants.byTarget(target.id).map((g) => g.id);
    this.deps.repos.targets.remove(target.id);
    this.deps.publisher.remove('grants', grantIds);
    this.deps.publisher.remove('targets', [target.id]);
    this.clearExpiredBanner(target);
  }

  /**
   * Banner Reconnect. A cli target reruns the CLI login (aws: `aws sso login --profile <p>`) and returns the
   * terminal id as `flowId`; the renderer attaches to it and re-runs `target.refresh` when it exits.
   */
  async reconnect(targetId: string): Promise<{ flowId: string; authMethod: AuthMethod }> {
    const target = this.require(targetId);
    if (target.authMethod === 'cli') {
      const r = await this.cliLogin(target.projectId, target.provider, accountOf(target) ?? undefined);
      return { flowId: r.terminalId, authMethod: 'cli' };
    }
    const r = this.connectStart(target.projectId, target.provider, target.env, target.name);
    return { flowId: r.flowId, authMethod: r.authMethod };
  }
}
