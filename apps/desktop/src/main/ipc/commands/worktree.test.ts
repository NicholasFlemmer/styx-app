import { describe, expect, it } from 'vitest';
import { fuzzyMatch, rankFiles } from './worktree';

const FILES = [
  'README.md',
  'package.json',
  'src/app.ts',
  'src/checkout.ts',
  'src/components/checkout.tsx',
  'src/components/checkout.test.tsx',
  'src/pay.ts',
  'test/checkout.spec.ts',
];

describe('fuzzyMatch', () => {
  it.each([
    ['src/components/checkout.ts', 'srcchk', true],
    ['src/components/checkout.ts', 'checkout', true],
    ['src/components/checkout.ts', 'xyz', false],
    ['abc', '', true],
    ['', 'a', false],
  ])('%s ~ %s → %s', (text, query, expected) => {
    expect(fuzzyMatch(text, query)).toBe(expected);
  });
});

describe('rankFiles (fs.find)', () => {
  it.each([
    ['empty / blank query keeps every path in order', '   ', FILES],
    [
      'exact basename first, then prefix matches, then substrings, then subsequences',
      'checkout.ts',
      [
        'src/checkout.ts',
        'src/components/checkout.tsx',
        // subsequence hits (c-h-e-c-k-o-u-t-.-t-s) keep their ls-files order
        'src/components/checkout.test.tsx',
        'test/checkout.spec.ts',
      ],
    ],
    [
      'a path prefix ranks with basename prefixes, before substrings',
      'src/c',
      ['src/checkout.ts', 'src/components/checkout.tsx', 'src/components/checkout.test.tsx'],
    ],
    ['basename prefix', 'pay', ['src/pay.ts']],
    ['case-insensitive, query trimmed', ' readme.MD ', ['README.md']],
    [
      'substring before subsequence',
      'out',
      [
        'src/checkout.ts',
        'src/components/checkout.tsx',
        'src/components/checkout.test.tsx',
        'test/checkout.spec.ts',
      ],
    ],
    ['no hit → empty', 'zzz', []],
  ])('%s', (_label, query, expected) => {
    expect(rankFiles(FILES, query)).toEqual(expected);
  });
});
