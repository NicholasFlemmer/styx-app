import { describe, expect, it, vi } from 'vitest';
import { makeTestApp } from '../test-support';

/**
 * Usage counts leave the process only from a real Styx (#122). A test, `pnpm dev` or fixture run makes a fresh
 * install id each time; sending from them put four test runs on the dashboard as "installs" on the first day.
 */
describe('usage counts wiring', () => {
  it('a container not told it may send never reaches the API, even with events recorded', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    const t = makeTestApp({ fetch: fetchSpy as unknown as typeof fetch });
    t.app.usageReports.record('app.launched');
    t.app.usageReports.record('lane.landed');
    await t.app.shutdown();
    const urls = fetchSpy.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls.filter((u) => u.includes('/v1/events'))).toEqual([]);
  });
});
