import type { Provider } from '../model/common';
import type { Target } from '../model/target';

/**
 * The `config` key naming the one project a target acts on, for providers whose login reaches several (main's
 * `ProviderAdapter.projectKey`): a Supabase project, Fly.io app, Railway environment, Render service.
 */
export const PROJECT_KEY_OF: Readonly<Partial<Record<Provider, string>>> = {
  supabase: 'ref',
  fly: 'app',
  railway: 'environmentId',
  render: 'serviceId',
};

type TargetRow = Pick<Target, 'id' | 'projectId' | 'provider' | 'env' | 'name' | 'config'>;

/**
 * Owner decision (2026-10-15, row 164): a staging or preview target may use the same project as a production target
 * of the same provider, but the person is told, because access granted on it can change production. This is the
 * other target of such a pair, from either side (null when there is none). Only targets of the same Styx project
 * count, and only a chosen, non-empty project value.
 */
export function sharedProdTarget<T extends TargetRow>(
  target: Pick<Target, 'id' | 'projectId' | 'provider' | 'env' | 'config'>,
  all: readonly T[],
): T | null {
  const key = PROJECT_KEY_OF[target.provider];
  const value = key === undefined ? undefined : target.config[key];
  if (key === undefined || typeof value !== 'string' || value === '') return null;
  return (
    all.find(
      (t) =>
        t.id !== target.id &&
        t.projectId === target.projectId &&
        t.provider === target.provider &&
        (t.env === 'prod') !== (target.env === 'prod') &&
        t.config[key] === value,
    ) ?? null
  );
}

/**
 * Whether access granted on `target` can reach production, for the sheet's warning and the `granted` audit row alike
 * (one rule, so they never disagree). `shared`: a non-prod target on the same project as a prod one. `unchosen`: a
 * non-prod target with no project picked, which falls back to the account's only project, while a prod target of the
 * same provider exists (counted conservatively). Null otherwise, and always for a prod target.
 */
export function prodReachOf<T extends TargetRow>(
  target: Pick<Target, 'id' | 'projectId' | 'provider' | 'env' | 'config'>,
  all: readonly T[],
): { kind: 'shared'; prod: T } | { kind: 'unchosen'; prod: T } | null {
  if (target.env === 'prod') return null;
  const shared = sharedProdTarget(target, all);
  if (shared !== null) return { kind: 'shared', prod: shared };
  const key = PROJECT_KEY_OF[target.provider];
  const value = key === undefined ? undefined : target.config[key];
  if (key === undefined || (typeof value === 'string' && value !== '')) return null;
  const prod = all.find(
    (t) =>
      t.id !== target.id &&
      t.projectId === target.projectId &&
      t.provider === target.provider &&
      t.env === 'prod',
  );
  return prod === undefined ? null : { kind: 'unchosen', prod };
}
