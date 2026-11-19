import { fixtures, type ReportResult } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { reportPage } from './report-page';

const report = (): ReportResult => {
  const r = fixtures.oneFixture().taskResults.find((x) => x.body.kind === 'report')?.body;
  if (r?.kind !== 'report') throw new Error('fixture');
  return r;
};

describe('reportPage', () => {
  it('draws the answer first, then numbers, trend, table and what to do', () => {
    const html = reportPage({
      report: report(),
      project: 'client-x',
      sharedBy: 'Nic',
      updated: 'now',
      css: 'link',
    });
    const order = ['A good week', 'R212 700', '<svg', 'Search, brand', 'Pause the display campaign'].map(
      (x) => html.indexOf(x),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('href="style.css"');
    expect(html).toContain('noindex');
    expect(html).toContain('from Google Ads and Analytics');
  });

  it('escapes everything the agent wrote and runs nothing', () => {
    const r = { ...report(), headline: '<script>alert(1)</script>', sources: ['"><img src=x onerror=1>'] };
    const html = reportPage({ report: r, project: '', sharedBy: '', updated: 'now', css: 'inline' });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<style>');
  });
});
