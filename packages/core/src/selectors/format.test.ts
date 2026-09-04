import { describe, expect, it } from 'vitest';
import { formatAge, formatChanges, formatClock, formatCountdown, joinScopes, padCount } from './format';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;

describe('formatCountdown', () => {
  it.each([
    [-5 * M, '0m'],
    [0, '0m'],
    [59 * M, '59m'],
    [58 * M + 59_000, '58m'],
    [H, '1h'],
    [H + 10 * M, '1h 10m'],
    [23 * H + 59 * M, '23h 59m'],
    [2 * D, '2d'],
    [2 * D + 5 * H, '2d'],
  ])('%i → %s', (ms, expected) => {
    expect(formatCountdown(ms)).toBe(expected);
  });
});

describe('formatAge', () => {
  const now = 10 * D;
  it.each([
    [null, '—'],
    [now, 'now'],
    [now + 5_000, 'now'],
    [now - 2 * M, '2m'],
    [now - 59 * M, '59m'],
    [now - H, '1h'],
    [now - 23 * H, '23h'],
    [now - D, '1d'],
    [now - 2 * D, '2d'],
  ])('%s → %s', (from, expected) => {
    expect(formatAge(from, now)).toBe(expected);
  });
});

describe('formatClock', () => {
  it('formats HH:MM in UTC by default and honours an offset', () => {
    const t = Date.UTC(2026, 2, 12, 9, 41);
    expect(formatClock(t)).toBe('09:41');
    expect(formatClock(t, 60)).toBe('10:41');
    expect(formatClock(t, -600)).toBe('23:41');
  });
});

describe('small helpers', () => {
  it('padCount', () => {
    expect(padCount(0)).toBe('00');
    expect(padCount(2)).toBe('02');
    expect(padCount(12)).toBe('12');
  });
  it('formatChanges', () => {
    expect(formatChanges({ added: 142, removed: 38, files: 3 })).toBe('+142 −38 · 3 files');
    expect(formatChanges({ added: 12, removed: 4, files: 1 })).toBe('+12 −4 · 1 file');
  });
  it('joinScopes', () => {
    expect(joinScopes(['read', 'write'])).toBe('read+write');
    expect(joinScopes(['read', 'write'], ', ')).toBe('read, write');
  });
});
