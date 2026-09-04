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
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { ConnectInput, ProviderRegistry, TargetInfo } from '../providers';
import type { Publisher } from '../store/publisher';
import type { ActivityService } from './activity-service';
import type { AuditService } from './audit-service';
import type { CredentialVault } from './credential-vault';
import type { GrantService } from './grant-service';
import { auditContext } from './labels';
import { logger } from './logger';

export interface TargetServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  audit: AuditService;
  providers: ProviderRegistry;
  vault: CredentialVault;
  grants: Pick<GrantService, 'cancelTargetGrants'>;
  activity: ActivityService;
  openExternal: (url: string) => Promise<void>;
}

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

  private placeholder(projectId: string, provider: Provider, env: Env, name: string | undefined): Target {
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
      authMethod: AUTH_METHOD[provider],
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
  ): Promise<Target> {
    const now = this.deps.clock.now();
    const next: Target = {
      ...target,
      credentialRef: r.credentialRef,
      config: { ...target.config, ...r.config } as Target['config'],
      name: target.fromProjectFile ? target.name : target.name || r.label,
      health: 'ok',
      healthCheckedAt: now,
      expiredAt: null,
    };
    this.upsertRow(next);
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
      body: message ?? '',
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

  reconnect(targetId: string): { flowId: string; authMethod: AuthMethod } {
    const target = this.require(targetId);
    const r = this.connectStart(target.projectId, target.provider, target.env, target.name);
    return { flowId: r.flowId, authMethod: r.authMethod };
  }
}
