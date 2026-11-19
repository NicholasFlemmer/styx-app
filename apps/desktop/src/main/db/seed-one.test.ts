import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../test-support';

describe('the one fixture (ADR-0033)', () => {
  it('seeds its campaign, report and live campaign, with the live one still approved', () => {
    const t = makeTestApp({ fixture: 'one' });
    const all = t.app.repos.taskResults.all();
    expect(all.map((r) => r.body.title).sort()).toEqual(['Black Friday retargeting', 'Weekly report', 'Winter sale']);
    const live = all.find((r) => r.body.title === 'Winter sale');
    expect(live).toMatchObject({ campaignId: '120000000000777', approved: { plan: { perDay: 5000 } } });
    expect(live?.launchApprovedAt).not.toBeNull();
  });
});
