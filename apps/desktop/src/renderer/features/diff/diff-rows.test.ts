import { fixtures } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { changeHeader, changeRows, laneRows, parsePatch, rowText } from './diff-rows';

describe('diff rows', () => {
  it('flattens the demo lane diff into a header row followed by body rows (prototype Repo block)', () => {
    const rows = laneRows(parsePatch(fixtures.demoLaneDiff));
    expect(rows[0]).toEqual({ kind: 'header', text: '@@ -1,8 +1,10 @@' });
    expect(rows.map((r) => rowText(r, 'compact'))).toEqual([
      '@@ -1,8 +1,10 @@',
      " import { sum } from './cart'",
      "+import { validate } from './validate'",
      ' ',
      ' export async function checkout(cart) {',
      '+  validate(cart)',
      '   const total = sum(cart.items)',
      '   const receipt = await pay(total)',
      '+  audit(receipt)',
      '   return receipt',
    ]);
    expect(rows.filter((r) => r.kind === 'add')).toHaveLength(3);
  });

  it('adds a file header row only when the diff spans several files', () => {
    const two = `${fixtures.demoLaneDiff}diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n`;
    const rows = laneRows(parsePatch(two));
    expect(rows.filter((r) => r.kind === 'header').map((r) => r.text)).toEqual([
      'checkout.ts',
      '@@ -1,8 +1,10 @@',
      'b.ts',
      '@@ -1 +1 @@',
    ]);
    expect(rows.filter((r) => r.kind === 'remove')).toEqual([{ kind: 'remove', text: 'x' }]);
  });

  it.each([
    ['spaced', ['  import { sum } from "./cart"', '+ import { validate } from "./validate"', '  ']],
    ['compact', [' import { sum } from "./cart"', '+import { validate } from "./validate"', ' ']],
  ] as const)('renders %s gutters for the first demo hunk', (gutter, expected) => {
    const change = fixtures.demoHunks()[0];
    expect(change).toBeDefined();
    if (change === undefined) return;
    expect(changeRows(change).map((r) => rowText(r, gutter))).toEqual(expected);
    expect(changeHeader(change)).toBe('@@ -1,2 +1,3 @@');
  });

  it('keeps headers verbatim regardless of gutter', () => {
    expect(rowText({ kind: 'header', text: '@@ -0,0 +1,31 @@' }, 'spaced')).toBe('@@ -0,0 +1,31 @@');
  });
});
