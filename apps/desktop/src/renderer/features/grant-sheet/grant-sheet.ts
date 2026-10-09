import {
  allowedDurations,
  approvalNeedsMfa,
  clampDuration,
  copy,
  DURATION_ORDER,
  fill,
  joinScopes,
  maxGrantDuration,
  platformCopy,
  PROVIDER_LABEL,
  type AskPayload,
  type Duration,
  type Env,
  type CopyPlatform,
  type Provider,
  type Scope,
  type TargetPolicy,
} from '@styx/core';

export const DURATIONS: readonly Duration[] = DURATION_ORDER;
export const DEFAULT_DURATION: Duration = '1h';

/** The ask's adapter fact (issue #29); a row without it reads as unscoped, the safe side. Main decides either way. */
export const credentialScopedOf = (payload: AskPayload | undefined): boolean =>
  payload?.kind === 'grant' ? (payload.credentialScoped ?? false) : false;

/**
 * Duration chips for the chosen scope: only what main will accept is enabled (a production write on a target whose
 * token can't be narrowed is `once` only), and the shown value is the person's pick clamped to that.
 */
export const durationChoice = (
  env: Env,
  scope: readonly Scope[],
  credentialScoped: boolean,
  picked: Duration,
): {
  value: Duration;
  onceOnly: boolean;
  options: { value: Duration; label: string; disabled: boolean }[];
} => {
  const max = maxGrantDuration(env, scope, credentialScoped);
  const allowed = allowedDurations(max);
  return {
    value: clampDuration(picked, max),
    onceOnly: max === 'once',
    options: DURATIONS.map((d) => ({
      value: d,
      label: copy.grantSheet.durations[d],
      disabled: !allowed.includes(d),
    })),
  };
};

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

/**
 * "Grant 1h · Touch ID" or "Grant 1h": the suffix appears whenever main will ask for OS authentication (prod write,
 * an ask-mfa target, or any prod scope on a target whose token can't be narrowed).
 */
export const grantButtonLabel = (
  target: { env: Env; policy: TargetPolicy },
  scope: readonly Scope[],
  duration: Duration,
  platform: CopyPlatform,
  credentialScoped: boolean,
): string => {
  const label = copy.grantSheet.durations[duration];
  return approvalNeedsMfa(target, scope, credentialScoped)
    ? fill(copy.grantSheet.grantMfa, { duration: label, mfa: platformCopy(platform).mfa })
    : fill(copy.grantSheet.grant, { duration: label });
};

const DURATION_SPOKEN: Record<Duration, string> = {
  once: 'one command',
  '1h': '1 hour',
  session: 'this session',
  always: 'always',
};

/** "Granted Codex read, write on Supabase prod for 1 hour" (spec §9 live region); `once` reads "for one command". */
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
