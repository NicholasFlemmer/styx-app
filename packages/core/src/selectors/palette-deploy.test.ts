import { describe, expect, it } from 'vitest';
import type { TargetId } from '../ids';
import { demoReadModel, ids } from '../fixtures/demo';
import type { Env } from '../model/common';
import type { Target } from '../model/target';
import { rows, tableFrom, type ReadModel } from '../read-model';
import { deployTargetLabel, deployTargetOptions } from './palette';

const base = demoReadModel();
const project = ids.project.acmeShop;
const vercel = base.targets.byId[ids.target.vercelProd];
if (vercel === undefined) throw new Error('fixture');

/** A target of acme-shop. Vercel is built in; a GCP one without a deploy command is learned by the agent. */
const t = (id: string, name: string, env: Env, provider: 'vercel' | 'gcp' = 'vercel'): Target => ({
  ...vercel,
  id: id as TargetId,
  name,
  env,
  provider,
  config: {},
});

/** acme-shop with exactly `targets`; another project's target stays, to prove the filter. */
const withTargets = (targets: Target[]): ReadModel => ({
  ...base,
  targets: tableFrom([...targets, ...rows(base.targets).filter((x) => x.projectId !== project)]),
});

describe('deployTargetLabel', () => {
  it('names a target the way the palette deploy rows do', () => {
    expect(deployTargetLabel({ name: 'Vercel', env: 'prod' })).toBe('Vercel prod');
  });
});

describe('deployTargetOptions (issue #9: the deploy button offers every target, prod last)', () => {
  const cases: { name: string; targets: Target[]; want: [label: string, prod: boolean, learn: boolean][] }[] =
    [
      { name: 'no targets', targets: [], want: [] },
      {
        name: 'only prod',
        targets: [t('t:prod', 'Vercel', 'prod')],
        want: [['Vercel prod', true, false]],
      },
      {
        name: 'prod + staging: staging first even when prod was connected first',
        targets: [t('t:prod', 'Vercel', 'prod'), t('t:stg', 'GCP', 'staging', 'gcp')],
        want: [
          ['GCP staging', false, true],
          ['Vercel prod', true, false],
        ],
      },
      {
        name: 'prod + preview + staging: preview, staging, prod',
        targets: [
          t('t:prod', 'Vercel', 'prod'),
          t('t:stg', 'Vercel', 'staging'),
          t('t:pre', 'Vercel', 'preview'),
        ],
        want: [
          ['Vercel preview', false, false],
          ['Vercel staging', false, false],
          ['Vercel prod', true, false],
        ],
      },
      {
        name: 'two prods and an scm target keep their own order within an env',
        targets: [
          t('t:prod', 'Vercel', 'prod'),
          t('t:scm', 'GitHub', 'scm', 'gcp'),
          t('t:eu', 'Vercel EU', 'prod'),
        ],
        want: [
          ['GitHub scm', false, true],
          ['Vercel prod', true, false],
          ['Vercel EU prod', true, false],
        ],
      },
    ];

  it.each(cases)('$name', ({ targets, want }) => {
    const got = deployTargetOptions(withTargets(targets), project);
    expect(got.map((o) => [o.label, o.prod, o.learn])).toEqual(want);
    for (const o of got) {
      const src = targets.find((x) => x.id === o.targetId);
      expect(o).toEqual({
        targetId: src?.id,
        label: deployTargetLabel(o),
        name: src?.name,
        env: src?.env,
        prod: src?.env === 'prod',
        learn: o.learn,
      });
    }
  });

  it('the demo acme-shop: Vercel preview and GitHub before the three prod targets', () => {
    expect(deployTargetOptions(base, project).map((o) => o.label)).toEqual([
      'Vercel preview',
      'GitHub acme/shop scm',
      'Vercel prod',
      'Supabase prod',
      'AWS acme-prod prod',
    ]);
  });
});
