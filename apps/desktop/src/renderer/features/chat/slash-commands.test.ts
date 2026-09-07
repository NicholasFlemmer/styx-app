import { fixtures, type Session } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { mentionItems, slashItems } from './slash-commands';

const session = (slashCommands: string[]): Session => ({
  ...fixtures.demoSessions()[0]!,
  slashCommands,
});

describe('slashItems', () => {
  it('lists every advertised command with `/` and a hint for known built-ins', () => {
    const items = slashItems(session(['compact', 'seo-audit']), '');
    expect(items.map((i) => i.label)).toEqual(['/compact', '/seo-audit']);
    expect(items[0]?.hint).toBe('Summarise the conversation to free context');
    expect(items[1]?.hint).toBeUndefined();
  });

  it.each([
    ['com', ['/compact']],
    ['ctx', []],
    ['ode', ['/model']],
    ['mdl', ['/model']],
    ['zzz', []],
  ])('filters on %s', (query, expected) => {
    expect(slashItems(session(['compact', 'model']), query).map((i) => i.label)).toEqual(expected);
  });

  it('prefix matches rank before substring, and substring before subsequence', () => {
    // `compact` has no c…a…p subsequence, so it drops out; `cpt` reaches it only as a subsequence.
    const items = slashItems(session(['recap', 'cap-plan', 'compact']), 'cap');
    expect(items.map((i) => i.label)).toEqual(['/cap-plan', '/recap']);
    expect(slashItems(session(['compact']), 'cpt').map((i) => i.label)).toEqual(['/compact']);
  });

  it('no session or no advertised commands yields nothing', () => {
    expect(slashItems(null, '')).toEqual([]);
    expect(slashItems(session([]), 'c')).toEqual([]);
  });
});

describe('mentionItems', () => {
  it('maps paths to rows keyed by path', () => {
    expect(mentionItems(['src/a.ts'])).toEqual([{ id: 'src/a.ts', label: 'src/a.ts' }]);
  });
});
