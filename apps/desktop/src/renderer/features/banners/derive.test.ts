import { copy, fixtures } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { deriveBanners, mergeBanners } from './derive';

describe('deriveBanners', () => {
  it('is empty for the demo fixture', () => {
    expect(deriveBanners(fixtures.demoReadModel(), fixtures.DEMO_NOW)).toEqual([]);
  });

  it('derives auth-expired, cli-missing and conflict rows from the error fixture with spec copy', () => {
    const rows = deriveBanners(fixtures.errorReadModel(), fixtures.DEMO_NOW);
    const keys = rows.map((r) => r.key);
    expect(keys).toContain(`auth-expired:${fixtures.ids.target.awsProd}`);
    expect(keys).toContain(`conflict:${fixtures.ids.worktree.fixCheckout}`);
    const expired = rows.find((r) => r.kind === 'auth-expired');
    expect(expired?.text).toBe('AWS acme-prod: credentials expired 2h ago. Agents requesting it are paused.');
    expect(expired?.cta).toBe(copy.errors.authExpired.cta);
    const conflict = rows.find((r) => r.kind === 'conflict');
    expect(conflict?.text).toBe(
      'fix/checkout conflicts with main in checkout.ts. Claude is paused until resolved.',
    );
    expect(conflict?.action).toEqual({ kind: 'resolve', worktreeId: fixtures.ids.worktree.fixCheckout });
  });

  it('groups cli-missing sessions per CLI with singular/plural copy', () => {
    const m = fixtures.demoReadModel();
    const sessions = { ...m.sessions, byId: { ...m.sessions.byId } };
    for (const id of [fixtures.ids.session.codex, fixtures.ids.session.claude]) {
      const s = sessions.byId[id];
      if (s !== undefined)
        sessions.byId[id] = { ...s, agent: 'codex', state: 'paused', pausedReason: 'cli-missing' };
    }
    const rows = deriveBanners({ ...m, sessions }, fixtures.DEMO_NOW);
    const cli = rows.filter((r) => r.kind === 'cli-missing');
    expect(cli).toHaveLength(1);
    expect(cli[0]?.text).toBe('codex not found on PATH. 2 session(s) cannot start.');
    expect(cli[0]?.action).toEqual({ kind: 'install-guide', agent: 'codex' });
  });
});

describe('mergeBanners', () => {
  it('a downloaded update is an info banner offering Restart; it says so when agents are working (#119)', () => {
    const base = fixtures.demoReadModel();
    const ready = { ...base.update, current: '0.2.0', status: 'ready' as const, next: '0.2.1', percent: 100 };
    const idleSessions = Object.fromEntries(
      Object.entries(base.sessions.byId).map(([id, s]) => [id, { ...s, state: 'idle' as const }]),
    );
    const quiet = deriveBanners(
      { ...base, update: ready, sessions: { ...base.sessions, byId: idleSessions } },
      fixtures.DEMO_NOW,
    );
    expect(quiet).toEqual([
      {
        key: 'update-ready:0.2.1',
        kind: 'update-ready',
        text: 'Styx 0.2.1 is ready. It installs the next time Styx quits.',
        cta: 'Restart to update',
        action: { kind: 'install-update' },
      },
    ]);
    const busy = deriveBanners({ ...base, update: ready }, fixtures.DEMO_NOW).find(
      (b) => b.kind === 'update-ready',
    );
    expect(busy?.text).toMatch(/^Styx 0\.2\.1 is ready\. \d+ agents are working; restarting stops them/);
    // Downloading, or nothing new: no banner.
    expect(
      deriveBanners({ ...base, update: { ...ready, status: 'downloading' } }, fixtures.DEMO_NOW),
    ).toEqual([]);
  });

  it('lets banner.set events override derived rows and hides dismissed keys', () => {
    const derived = deriveBanners(fixtures.errorReadModel(), fixtures.DEMO_NOW);
    const key = `auth-expired:${fixtures.ids.target.awsProd}`;
    const merged = mergeBanners(
      derived,
      {
        [key]: {
          bannerKey: key,
          kind: 'auth-expired',
          text: 'from main',
          cta: 'Reconnect',
          action: { kind: 'reconnect', targetId: fixtures.ids.target.awsProd },
          sessionId: null,
          reason: null,
        },
      },
      [`conflict:${fixtures.ids.worktree.fixCheckout}`],
    );
    expect(merged.find((b) => b.key === key)?.text).toBe('from main');
    expect(merged.some((b) => b.kind === 'conflict')).toBe(false);
  });
});
