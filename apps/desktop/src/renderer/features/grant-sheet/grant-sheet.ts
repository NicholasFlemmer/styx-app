import {
  copy,
  fill,
  joinScopes,
  platformCopy,
  PROVIDER_LABEL,
  requiresMfa,
  type Duration,
  type Env,
  type CopyPlatform,
  type Provider,
  type Scope,
} from '@styx/core';

export const DURATIONS: readonly Duration[] = ['once', '1h', 'session', 'always'];
export const DEFAULT_DURATION: Duration = '1h';

/** Scopes a provider can be asked for (prototype: Supabase lists Read schema / Write / Delete / drop). */
const PROVIDER_SCOPES: Record<Provider, readonly Scope[]> = {
  supabase: ['read', 'write', 'delete'],
  aws: ['read', 'write', 'delete'],
  gcp: ['read', 'write', 'delete'],
  ssh: ['read', 'write', 'delete'],
  vercel: ['read', 'deploy'],
  github: ['read', 'write'],
};

/** Provider kind tag next to the ENV tag (prototype: `PROD` `POSTGRES` for Supabase). */
const PROVIDER_KIND: Record<Provider, string> = {
  supabase: 'Postgres',
  vercel: 'Deploy',
  aws: 'IAM',
  gcp: 'IAM',
  github: 'Git',
  ssh: 'SSH',
};

/** Env noun in the title (`Supabase / prod db`); other providers read `Vercel / prod`. */
export const envTitle = (provider: Provider, env: Env): string =>
  provider === 'supabase' ? `${env} db` : env;

export const providerKind = (provider: Provider): string => PROVIDER_KIND[provider];
export const providerLabel = (provider: Provider): string => PROVIDER_LABEL[provider];

/** Rows of the Scope box: the provider's scopes plus anything unusual the agent asked for, requested ones first-class. */
export const scopeRows = (
  provider: Provider,
  requested: readonly Scope[],
): { scope: Scope; label: string; requested: boolean }[] => {
  const all = [...PROVIDER_SCOPES[provider]];
  for (const s of requested) if (!all.includes(s)) all.push(s);
  return all.map((scope) => ({
    scope,
    label: copy.grantSheet.scopes[scope],
    requested: requested.includes(scope),
  }));
};

export interface GrantPayload {
  scope: Scope[];
  duration: Duration;
}

/** Grant payload from the sheet state; requested scopes may only be unchecked (never widened). */
export const grantPayload = (
  requested: readonly Scope[],
  checked: readonly Scope[],
  duration: Duration,
): GrantPayload => ({
  scope: requested.filter((s) => checked.includes(s)),
  duration,
});

/** "Grant 1h · Touch ID" (prod write) or "Grant 1h". */
export const grantButtonLabel = (
  env: Env,
  scope: readonly Scope[],
  duration: Duration,
  platform: CopyPlatform,
): string => {
  const label = copy.grantSheet.durations[duration];
  return requiresMfa(env, scope)
    ? fill(copy.grantSheet.grantMfa, { duration: label, mfa: platformCopy(platform).mfa })
    : fill(copy.grantSheet.grant, { duration: label });
};

const DURATION_SPOKEN: Record<Duration, string> = {
  once: 'once',
  '1h': '1 hour',
  session: 'this session',
  always: 'always',
};

/** "Granted Codex read, write on Supabase prod for 1 hour" (spec §9 live region). */
export const grantAnnouncement = (
  agent: string,
  scope: readonly Scope[],
  target: string,
  duration: Duration,
): string =>
  fill(copy.grantResult.announce, {
    agent,
    scopes: joinScopes(scope, ', '),
    target,
    duration: DURATION_SPOKEN[duration],
  });
