import { describe, expect, it } from 'vitest';
import { SkillsService } from './skills-service';
import type { Repos } from '../db/repos';

/**
 * Hits the real catalogue. Skipped unless STYX_LIVE=1, so CI and offline runs are unaffected — but it exists
 * because the pinned path was wrong once already: the skills live under `skills/`, not at the repo root, and a
 * stubbed test cannot catch that.
 */
const live = process.env['STYX_LIVE'] === '1';

describe.skipIf(!live)('skills catalogue (live)', () => {
  it('returns the real published skills', async () => {
    const svc = new SkillsService({
      repos: { projects: { get: () => null } } as unknown as Repos,
      fetch,
      home: '/tmp/styx-live-home',
    });
    const rows = await svc.catalogue();
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((r) => r.name !== '' && r.description !== '')).toBe(true);
    expect(rows.map((r) => r.directory)).toContain('pdf');
  }, 60_000);
});
