import { copy, fill, PROVIDER_LABEL } from '@styx/core';
import type { Provider, ProviderProject } from './types';

export type Picked = { ok: true; project: ProviderProject } | { ok: false; error: string };

/**
 * Which project a target acts on (Supabase project, Fly.io app, Railway environment, Render service): the one it was
 * given, or the account's only one. Never the first of several (issue #5: prod and staging targets both landed on
 * whichever project the API listed first).
 */
export function pickProjectOf(
  provider: Provider,
  projects: readonly ProviderProject[],
  chosen: unknown,
): Picked {
  const label = PROVIDER_LABEL[provider];
  if (typeof chosen === 'string' && chosen !== '') {
    const project = projects.find((p) => p.id === chosen);
    return project
      ? { ok: true, project }
      : { ok: false, error: fill(copy.connect.project.gone, { ref: chosen, provider: label }) };
  }
  if (projects.length === 1 && projects[0]) return { ok: true, project: projects[0] };
  return {
    ok: false,
    error: fill(projects.length === 0 ? copy.connect.project.none : copy.connect.project.choose, {
      provider: label,
    }),
  };
}
