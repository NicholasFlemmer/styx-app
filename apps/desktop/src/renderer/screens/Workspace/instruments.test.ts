import { describe, expect, it } from 'vitest';
import { INSTRUMENT_CODE, defaultInstrument, instrumentOf, moveInstrument } from './instruments';

describe('instruments (#140)', () => {
  it('stores each instrument as its own code and reads it back', () => {
    for (const [k, n] of Object.entries(INSTRUMENT_CODE)) expect(instrumentOf(n, 'tasks')).toBe(k);
    expect(instrumentOf(undefined, 'code')).toBe('code');
    expect(instrumentOf(42, 'design')).toBe('design');
  });

  it('defaults to the person’s first tab once they arranged them, else Preview or Tasks', () => {
    expect(defaultInstrument([], true)).toBe('design');
    expect(defaultInstrument([], false)).toBe('tasks');
    expect(defaultInstrument(['canvas', 'tasks'], true)).toBe('canvas');
  });

  it('moves a tab, clamped to the ends', () => {
    const order = ['tasks', 'canvas', 'design', 'changes', 'code', 'terminal'] as const;
    expect(moveInstrument(order, 'code', 0)).toEqual([
      'code',
      'tasks',
      'canvas',
      'design',
      'changes',
      'terminal',
    ]);
    expect(moveInstrument(order, 'tasks', 99).at(-1)).toBe('tasks');
    expect(moveInstrument(order, 'canvas', -3)[0]).toBe('canvas');
  });
});
