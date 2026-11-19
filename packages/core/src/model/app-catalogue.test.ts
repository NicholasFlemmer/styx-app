import { describe, expect, it } from 'vitest';
import { APP_CATALOGUE, catalogueEntryFor } from './app-catalogue';
import { connectedAppUrlOk } from './connected-app';

describe('APP_CATALOGUE', () => {
  it('gives every one-click app a safe address, and every other one a reason', () => {
    for (const a of APP_CATALOGUE) {
      if (a.access === 'connect') expect(a.url !== null && connectedAppUrlOk(a.url), a.id).toBe(true);
      else expect(a.url, a.id).toBeNull();
      if (a.access === 'needs-setup' || a.access === 'coming') expect(a.note, a.id).not.toBeNull();
    }
    expect(new Set(APP_CATALOGUE.map((a) => a.id)).size).toBe(APP_CATALOGUE.length);
  });

  it('finds the entry an added app came from by its origin', () => {
    expect(catalogueEntryFor('https://mcp.notion.com')?.id).toBe('notion');
    expect(catalogueEntryFor('https://example.com')).toBeNull();
  });
});
