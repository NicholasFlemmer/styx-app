import { fixtures } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../test-support';
import { ReportSchedule, lastMondayMorning } from './report-schedule';

const local = (y: number, m: number, d: number, h: number) => new Date(y, m - 1, d, h, 0, 0, 0).getTime();

describe('lastMondayMorning', () => {
  it.each([
    [local(2026, 11, 19, 12), local(2026, 11, 16, 7)], // Wednesday → that week's Monday
    [local(2026, 11, 16, 8), local(2026, 11, 16, 7)], // Monday after 07:00
    [local(2026, 11, 16, 6), local(2026, 11, 9, 7)], // Monday before 07:00 → the week before
    [local(2026, 11, 22, 23), local(2026, 11, 16, 7)], // Sunday night
  ])('%s → %s', (now, want) => expect(lastMondayMorning(now)).toBe(want));
});

describe('ReportSchedule', () => {
  it('asks a weekly report again once per week, from Monday morning', async () => {
    const t = makeTestApp({ fixture: 'one' });
    const report = t.app.repos.taskResults.all().find((r) => r.body.kind === 'report');
    if (report === undefined) throw new Error('fixture');
    let now = local(2026, 11, 18, 10); // a Tuesday
    const told: string[] = [];
    const s = new ReportSchedule({
      repos: t.app.repos,
      now: () => now,
      tell: async (id) => void told.push(id),
      publish: () => undefined,
    });
    s.setWeekly(report.id, true);
    expect(t.app.repos.taskResults.get(report.id)?.weekly).toBe(true);
    expect(await s.tick()).toEqual([]); // switched on mid-week: waits for Monday
    now = local(2026, 11, 23, 9); // next Monday, 09:00
    expect(await s.tick()).toEqual([report.id]);
    expect(await s.tick()).toEqual([]); // once a week
    expect(told).toEqual([report.id]);
    s.setWeekly(report.id, false);
    now = local(2026, 11, 30, 9);
    expect(await s.tick()).toEqual([]);
    expect(() => s.setWeekly(fixtures.ids.session.claude, true)).toThrow();
  });
});
