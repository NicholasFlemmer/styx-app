import { describe, expect, it } from 'vitest';
import sitemap from '../app/sitemap';
import { dayOf } from './dates';

describe('sitemap', () => {
  it('dates each page by its content, the same on every build', () => {
    const a = sitemap().map((e) => [e.url, (e.lastModified as Date).toISOString()]);
    const b = sitemap().map((e) => [e.url, (e.lastModified as Date).toISOString()]);
    expect(a).toEqual(b);
    // Nothing is stamped with "now".
    for (const [, at] of a) expect(at?.endsWith('T00:00:00.000Z')).toBe(true);
  });

  it('reads the dates the pages print', () => {
    expect(dayOf('29 September 2026').toISOString()).toBe('2026-09-29T00:00:00.000Z');
    expect(() => dayOf('soon')).toThrow();
  });
});
