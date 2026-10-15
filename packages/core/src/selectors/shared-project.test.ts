import { describe, expect, it } from 'vitest';
import { demoReadModel, ids } from '../fixtures/demo';
import type { Target } from '../model/target';
import { rows } from '../read-model';
import { PROJECT_KEY_OF, prodReachOf, sharedProdTarget } from './shared-project';

const base = rows(demoReadModel().targets).find((t) => t.id === ids.target.supabaseProd);
if (base === undefined) throw new Error('fixture');
const t = (id: string, over: Partial<Target>): Target => ({ ...base, id: id as Target['id'], ...over });

const prod = t('prod', { env: 'prod', config: { ref: 'abc' } });
const staging = t('staging', { env: 'staging', config: { ref: 'abc' } });

describe('sharedProdTarget (row 164: warn, never refuse)', () => {
  it.each([
    ['staging shares prod’s project → the prod target', staging, [prod, staging], 'prod'],
    ['seen from prod → the staging target', prod, [prod, staging], 'staging'],
    [
      'a preview target counts as non-prod',
      t('pv', { env: 'preview', config: { ref: 'abc' } }),
      [prod],
      'prod',
    ],
    ['two non-prod targets never warn', staging, [t('s2', { env: 'preview', config: { ref: 'abc' } })], null],
    ['two prod targets never warn', prod, [t('p2', { env: 'prod', config: { ref: 'abc' } })], null],
    ['a different project', staging, [t('p', { env: 'prod', config: { ref: 'xyz' } })], null],
    [
      'another Styx project',
      staging,
      [t('p', { env: 'prod', projectId: ids.project.blogV2, config: { ref: 'abc' } })],
      null,
    ],
    [
      'another provider',
      staging,
      [t('p', { env: 'prod', provider: 'render', config: { ref: 'abc' } })],
      null,
    ],
    ['itself is not a pair', staging, [staging], null],
    ['no project chosen', t('s', { env: 'staging', config: {} }), [prod], null],
    [
      'an empty project',
      t('s', { env: 'staging', config: { ref: '' } }),
      [t('p', { env: 'prod', config: { ref: '' } })],
      null,
    ],
    [
      'a provider without projects',
      t('s', { env: 'staging', provider: 'vercel', config: { ref: 'abc' } }),
      [prod],
      null,
    ],
  ] as const)('%s', (_name, target, all, want) => {
    expect(sharedProdTarget(target, all)?.id ?? null).toBe(want);
  });

  it('knows the project key of every provider whose login reaches several projects', () => {
    expect(PROJECT_KEY_OF).toEqual({
      supabase: 'ref',
      fly: 'app',
      railway: 'environmentId',
      render: 'serviceId',
    });
  });
});

describe('prodReachOf (one rule for the sheet warning and the audit flag)', () => {
  const unchosen = t('u', { env: 'staging', config: {} });
  it.each([
    ['a prod target never warns', prod, [prod, staging], null],
    ['staging on prod’s project → shared', staging, [prod, staging], { kind: 'shared', id: 'prod' }],
    [
      'no project picked while prod exists → unchosen',
      unchosen,
      [prod, unchosen],
      { kind: 'unchosen', id: 'prod' },
    ],
    [
      'an empty project value counts as none picked',
      t('e', { env: 'staging', config: { ref: '' } }),
      [prod],
      { kind: 'unchosen', id: 'prod' },
    ],
    ['no project picked and no prod target', unchosen, [unchosen, staging], null],
    [
      'no project picked, prod is another provider',
      unchosen,
      [t('p', { env: 'prod', provider: 'render', config: {} })],
      null,
    ],
    [
      'no project picked, prod in another Styx project',
      unchosen,
      [t('p', { env: 'prod', projectId: ids.project.blogV2, config: {} })],
      null,
    ],
    ['its own project, not prod’s', t('own', { env: 'staging', config: { ref: 'own' } }), [prod], null],
    [
      'a provider with no project key',
      t('g', { env: 'staging', provider: 'github', config: {} }),
      [t('gp', { env: 'prod', provider: 'github', config: {} })],
      null,
    ],
  ] as const)('%s', (_name, target, all, expected) => {
    const r = prodReachOf(target, all);
    expect(r === null ? null : { kind: r.kind, id: r.prod.id }).toEqual(expected);
  });
});
