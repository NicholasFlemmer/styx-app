import { describe, expect, it } from 'vitest';
import { COMPETITORS } from './index';
import { ROWS } from './types';

/** Every comparison page: search limits, a full table, sources to check it against, and honesty about them. */
describe('comparison pages', () => {
  it('have unique, url-safe slugs', () => {
    const slugs = COMPETITORS.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/);
  });

  it.each(COMPETITORS.map((c) => [c.slug, c] as const))('%s fits search limits and is complete', (_, c) => {
    expect(c.title.length).toBeLessThanOrEqual(60);
    expect(c.description.length).toBeLessThanOrEqual(155);
    for (const [key] of ROWS) expect(c.cells[key].trim()).not.toBe('');
    // A comparison that never says where the other product is ahead is an ad, not a comparison.
    expect(c.ahead.length).toBeGreaterThanOrEqual(2);
    expect(c.sources.length).toBeGreaterThanOrEqual(3);
    for (const s of c.sources) expect(s.url).toMatch(/^https:\/\//);
    expect(c.summary.length).toBeGreaterThanOrEqual(3);
    expect(c.faq.length).toBeGreaterThanOrEqual(1);
    expect(c.checked).toMatch(/^\d{1,2} [A-Z][a-z]+ \d{4}$/);
  });
});
