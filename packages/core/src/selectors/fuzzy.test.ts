import { describe, expect, it } from 'vitest';
import { fuzzyBest, fuzzyScore } from './fuzzy';

describe('fuzzyScore', () => {
  it('empty query matches everything with 0', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('   ', 'anything')).toBe(0);
  });
  it('null when a character is missing or out of order', () => {
    expect(fuzzyScore('xyz', 'Deploy acme-shop')).toBeNull();
    expect(fuzzyScore('pd', 'deploy')).toBeNull();
  });
  it('subsequence matches score by hit count', () => {
    expect(fuzzyScore('dpy', 'deploy')).toBe(1 + 2 + 1 + 1);
  });
  it('word-start and adjacency bonuses rank better matches first', () => {
    const wordStart = fuzzyScore('sw', 'Switch to blog-v2') ?? 0;
    const midWord = fuzzyScore('sw', 'answer') ?? 0;
    expect(wordStart).toBeGreaterThan(midWord);
    const adjacent = fuzzyScore('ver', 'Vercel') ?? 0;
    const spread = fuzzyScore('ver', 'v-e-r') ?? 0;
    expect(adjacent).toBeGreaterThan(spread);
  });
  it('contiguous substring gets an extra bonus', () => {
    const contiguous = fuzzyScore('shop', 'acme-shop') ?? 0;
    const scattered = fuzzyScore('shop', 's h o p') ?? 0;
    expect(contiguous).toBeGreaterThan(scattered);
  });
  it('spaces in the query are skipped and case is ignored', () => {
    expect(fuzzyScore('Grant Codex', 'grant codex → supabase prod')).not.toBeNull();
    expect(fuzzyScore('CODEX', 'Codex')).toBe(fuzzyScore('codex', 'Codex'));
  });
});

describe('fuzzyBest', () => {
  it('returns the best field score or null', () => {
    expect(fuzzyBest('open', ['Deploy acme-shop → Vercel prod', 'open · 58m'])).toBe(
      fuzzyScore('open', 'open · 58m'),
    );
    expect(fuzzyBest('zzz', ['a', 'b'])).toBeNull();
    expect(fuzzyBest('a', ['xa', 'a b'])).toBe(fuzzyScore('a', 'a b'));
  });
});
