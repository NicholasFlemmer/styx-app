import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DESIGN_TOKENS,
  designScreens,
  designTokensSchema,
  parseDesignPath,
  screenName,
  tokensCss,
  type DesignFile,
} from './design';
import { instrumentOrderOf, INSTRUMENTS } from './settings';

describe('design files (#140)', () => {
  it.each([
    ['checkout/desktop.html', { screen: 'checkout', size: 'desktop', fidelity: 'hi' }],
    ['order-history/phone.wire.html', { screen: 'order-history', size: 'phone', fidelity: 'wire' }],
    ['checkout/tablet.html', { screen: 'checkout', size: 'tablet', fidelity: 'hi' }],
    ['tokens.json', null],
    ['checkout/watch.html', null],
    ['../etc/desktop.html', null],
    ['Checkout/desktop.html', null],
    ['a/b/desktop.html', null],
  ])('%s', (path, want) => {
    expect(parseDesignPath(path)).toEqual(want);
  });

  it('names screens from their slug', () => {
    expect(screenName('order-history')).toBe('Order history');
    expect(screenName('checkout')).toBe('Checkout');
  });

  it('groups files into screens, sorted, each by size then fidelity', () => {
    const f = (path: string): DesignFile => {
      const p = parseDesignPath(path);
      if (p === null) throw new Error(path);
      return { path, ...p, mtime: 0 };
    };
    const screens = designScreens([
      f('settings/desktop.html'),
      f('checkout/phone.html'),
      f('checkout/desktop.wire.html'),
      f('checkout/desktop.html'),
    ]);
    expect(screens.map((s) => s.slug)).toEqual(['checkout', 'settings']);
    expect(screens[0]?.files.map((x) => x.path)).toEqual([
      'checkout/desktop.html',
      'checkout/desktop.wire.html',
      'checkout/phone.html',
    ]);
  });

  it('writes tokens as CSS variables, and the default tokens are valid', () => {
    expect(designTokensSchema.safeParse(DEFAULT_DESIGN_TOKENS).success).toBe(true);
    const css = tokensCss({ ...DEFAULT_DESIGN_TOKENS, fonts: { heading: 'Inter Display', body: 'system-ui' } });
    expect(css).toContain('--color-primary: #2F5BFF;');
    expect(css).toContain('--font-heading: "Inter Display", system-ui');
    expect(css).toContain('--font-body: system-ui, -apple-system, sans-serif;');
    expect(css).toContain('--text-display-size: 28px;');
    expect(css).toContain('--radius: 8px;');
    expect(tokensCss({ ...DEFAULT_DESIGN_TOKENS, fonts: { heading: 'x"; } body {', body: 'a' } })).not.toContain(
      '}"',
    );
  });
});

describe('instrumentOrderOf (#140)', () => {
  it('keeps the person’s order, drops unknown and repeated keys, appends what is missing', () => {
    expect(instrumentOrderOf([])).toEqual([...INSTRUMENTS]);
    expect(instrumentOrderOf(['canvas', 'design', 'bogus', 'canvas'])).toEqual([
      'canvas',
      'design',
      'tasks',
      'changes',
      'code',
      'terminal',
    ]);
  });
});
