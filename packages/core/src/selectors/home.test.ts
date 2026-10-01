import { describe, expect, it } from 'vitest';
import { DEMO_NOW, demoReadModel, emptyReadModel, ids } from '../fixtures/demo';
import { upsertRows } from '../read-model';
import { readyToLandCount } from './counts';
import { homeActivity, homeGreeting, homeProjectRows, homeSummary } from './home';

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

describe('home head (ADR-0027)', () => {
  it.each([
    [8, 'Nic Flemmer', 'Good morning, Nic'],
    [13, 'Nic', 'Good afternoon, Nic'],
    [21, '  Ada  Lovelace ', 'Good evening, Ada'],
    [9, null, 'All projects'],
    [9, '   ', 'All projects'],
  ])('greets at %i with %j as %s', (hour, name, line) => {
    expect(homeGreeting(hour, name)).toBe(line);
  });

  it.each([
    [0, 0, 'Nothing needs you. No agents are working.'],
    [1, 1, '1 thing needs you. 1 agent is working.'],
    [2, 3, '2 things need you. 3 agents are working.'],
  ])('%i need you, %i working → %s', (needs, working, line) => {
    expect(homeSummary(needs, working)).toBe(line);
  });

  it('each project row carries its lanes that have not landed, most urgent first', () => {
    const acme = homeProjectRows(demoReadModel(), NOW).find((r) => r.projectId === ids.project.acmeShop);
    expect(acme?.lanes.length).toBeGreaterThan(0);
    expect(acme?.lanes[0]?.status).toBe('your-turn');
    expect(acme?.lanes.some((l) => l.status === 'landed')).toBe(false);
  });

  it('counts finished lanes with unmerged changes as ready to land, nothing else', () => {
    const m = demoReadModel();
    const s = m.sessions.byId[ids.session.claude];
    if (s === undefined) throw new Error('fixture');
    const w = m.worktrees.byId[s.worktreeId];
    if (w === undefined) throw new Error('fixture');
    const base = readyToLandCount(m);
    const done = { ...s, state: 'done' as const, endedAt: NOW, pid: null, exitCode: 0 };
    const finished = { ...m, sessions: upsertRows(m.sessions, [done]) };
    expect(readyToLandCount(finished)).toBe(
      base + (w.changes.files > 0 && w.mergedAt === null && !w.isMain ? 1 : 0),
    );
    const merged = { ...finished, worktrees: upsertRows(m.worktrees, [{ ...w, mergedAt: NOW }]) };
    expect(readyToLandCount(merged)).toBe(base);
    const empty = {
      ...finished,
      worktrees: upsertRows(m.worktrees, [{ ...w, changes: { files: 0, added: 0, removed: 0 } }]),
    };
    expect(readyToLandCount(empty)).toBe(base);
    const task = { ...m, sessions: upsertRows(m.sessions, [{ ...done, purpose: 'learn-run' as const }]) };
    expect(readyToLandCount(task)).toBe(base);
    const gone = {
      ...m,
      sessions: upsertRows(m.sessions, [{ ...done, worktreeId: 'wt_gone' as typeof done.worktreeId }]),
    };
    expect(readyToLandCount(gone)).toBe(base);
  });
});
