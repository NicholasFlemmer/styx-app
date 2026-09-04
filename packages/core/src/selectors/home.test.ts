import { describe, expect, it } from 'vitest';
import { DEMO_NOW, demoReadModel, emptyReadModel, ids } from '../fixtures/demo';
import { upsertRows } from '../read-model';
import { homeActivity, homeProjectRows } from './home';

const NOW = DEMO_NOW;

describe('homeActivity', () => {
  it('renders the prototype feed newest first', () => {
    expect(homeActivity(demoReadModel(), NOW).map((r) => `${r.t} · ${r.who} · ${r.what}`)).toEqual([
      '2m · Claude · acme-shop · edited checkout.ts, pay.ts · 42 tests pass',
      '3m · Codex · acme-shop · requested Supabase prod write',
      '9m · Claude · blog-v2 · plan ready, 4 files',
      '31m · Gemini · infra-tools · rewriting README',
      '1h · system · revoked Gemini → AWS acme-prod (idle 1h)',
      '1d · Cursor · acme-shop · PR #212 merged',
    ]);
  });
  it('sorts regardless of input order and is empty for the empty fixture', () => {
    const model = demoReadModel();
    const reversed = { ...model, activity: [...model.activity].reverse() };
    expect(homeActivity(reversed, NOW).map((r) => r.id)).toEqual(homeActivity(model, NOW).map((r) => r.id));
    expect(homeActivity(emptyReadModel(), NOW)).toEqual([]);
  });
});

describe('homeProjectRows', () => {
  it('renders the prototype project table', () => {
    expect(
      homeProjectRows(demoReadModel(), NOW).map((r) => [
        r.name,
        r.path,
        r.branch,
        r.agents,
        r.targets,
        r.last,
        r.needs,
      ]),
    ).toEqual([
      [
        'acme-shop',
        '~/code/acme-shop',
        'fix/checkout',
        'Claude, Codex, Gemini',
        'Vercel, Supabase, AWS, GitHub',
        '2m',
        true,
      ],
      ['blog-v2', '~/code/blog-v2', 'feat/mdx', 'Claude', 'Vercel, GitHub', '9m', true],
      ['infra-tools', '~/code/infra-tools', 'main', 'Gemini', 'AWS, GCP', '31m', false],
      ['client-x', '~/work/client-x', 'main', 'shell', 'GCP, GitHub', '1h', false],
      ['side-api', '~/code/side-api', 'main', '—', 'Supabase', '2d', false],
    ]);
    expect(homeProjectRows(demoReadModel(), NOW)[0]).toMatchObject({
      projectId: ids.project.acmeShop,
      initials: 'AS',
    });
  });
  it('follows rail order, skips removed projects, and dashes missing targets', () => {
    const model = demoReadModel();
    const side = model.projects.byId[ids.project.sideApi];
    const acme = model.projects.byId[ids.project.acmeShop];
    if (side === undefined || acme === undefined) throw new Error('fixture');
    const reordered = {
      ...model,
      projects: upsertRows(model.projects, [
        { ...side, railOrder: -1 },
        { ...acme, removedAt: NOW },
      ]),
      targets: { byId: {}, ids: [] },
    };
    const names = homeProjectRows(reordered, NOW);
    expect(names.map((r) => r.name)).toEqual(['side-api', 'blog-v2', 'infra-tools', 'client-x']);
    expect(names.every((r) => r.targets === '—')).toBe(true);
    expect(homeProjectRows(emptyReadModel(), NOW)).toEqual([]);
  });
});
