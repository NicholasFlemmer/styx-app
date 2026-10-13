import { describe, expect, it } from 'vitest';
import {
  CANVAS_EXTENT,
  DEFAULT_DESIGN_TOKENS,
  designCanvasFileSchema,
  parseDesignCanvasFile,
  serializeDesignCanvasFile,
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
    const css = tokensCss({
      ...DEFAULT_DESIGN_TOKENS,
      fonts: { heading: 'Inter Display', body: 'system-ui' },
    });
    expect(css).toContain('--color-primary: #2F5BFF;');
    expect(css).toContain('--font-heading: "Inter Display", system-ui');
    expect(css).toContain('--font-body: system-ui, -apple-system, sans-serif;');
    expect(css).toContain('--text-display-size: 28px;');
    expect(css).toContain('--radius: 8px;');
    expect(
      tokensCss({ ...DEFAULT_DESIGN_TOKENS, fonts: { heading: 'x"; } body {', body: 'a' } }),
    ).not.toContain('}"');
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

describe('canvas.json (ADR-0030)', () => {
  const good = {
    version: 1,
    boards: { 'checkout/desktop.html': { x: 0, y: -8 }, 'a/phone.wire.html': { x: 1360, y: 0 } },
  };
  it.each([
    ['a valid file', JSON.stringify(good), 'ok'],
    ['no boards yet', '{"version":1,"boards":{}}', 'ok'],
    ['not JSON', '{version:1', 'invalid-json'],
    ['a newer version', '{"version":2,"boards":{}}', 'newer-version'],
    ['no version', '{"boards":{}}', 'invalid-schema'],
    ['an array', '[]', 'invalid-schema'],
    [
      'a key that is not a screen file',
      '{"version":1,"boards":{"../../etc/passwd":{"x":0,"y":0}}}',
      'invalid-schema',
    ],
    ['tokens.json as a key', '{"version":1,"boards":{"tokens.json":{"x":0,"y":0}}}', 'invalid-schema'],
    ['a fractional position', '{"version":1,"boards":{"a/desktop.html":{"x":0.5,"y":0}}}', 'invalid-schema'],
    [
      'a position far away',
      `{"version":1,"boards":{"a/desktop.html":{"x":${CANVAS_EXTENT + 1},"y":0}}}`,
      'invalid-schema',
    ],
    ['a missing coordinate', '{"version":1,"boards":{"a/desktop.html":{"x":0}}}', 'invalid-schema'],
  ])('%s → %s', (_, text, code) => {
    const r = parseDesignCanvasFile(text);
    expect(r.ok ? 'ok' : r.error.code).toBe(code);
  });
  it('refuses more than 1000 boards', () => {
    const boards: Record<string, { x: number; y: number }> = {};
    for (let i = 0; i < 1001; i += 1) boards[`s${i}/desktop.html`] = { x: 0, y: 0 };
    expect(designCanvasFileSchema.safeParse({ version: 1, boards }).success).toBe(false);
  });
  it('serializes stably (sorted, positions only) and parses back', () => {
    const text = serializeDesignCanvasFile({
      version: 1,
      boards: { 'z/desktop.html': { x: 8, y: 16 }, 'a/phone.html': { x: 0, y: 0 } },
    });
    expect(text).toBe(
      '{\n  "version": 1,\n  "boards": {\n    "a/phone.html": {\n      "x": 0,\n      "y": 0\n    },\n    "z/desktop.html": {\n      "x": 8,\n      "y": 16\n    }\n  }\n}\n',
    );
    const back = parseDesignCanvasFile(text);
    expect(back.ok && back.file.boards['z/desktop.html']).toEqual({ x: 8, y: 16 });
  });
});
