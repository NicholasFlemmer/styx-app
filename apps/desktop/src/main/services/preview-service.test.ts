import { describe, expect, it } from 'vitest';
import { deviceBounds, normaliseUrl, viewZoom } from './preview-service';

/**
 * The design window loads whatever the user types, so the URL guard is the security boundary: a preview must
 * never become a way to navigate to a local file or an app-internal scheme.
 */
describe('preview URL', () => {
  it('adds http:// to a bare host:port, which is what people actually type', () => {
    expect(normaliseUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(normaliseUrl('  127.0.0.1:5173  ')).toBe('http://127.0.0.1:5173/');
    expect(normaliseUrl('localhost:3000/dashboard')).toBe('http://localhost:3000/dashboard');
  });

  it('keeps an explicit http or https URL as given, for local hosts only', () => {
    expect(normaliseUrl('https://localhost:8443')).toBe('https://localhost:8443/');
    expect(normaliseUrl('http://localhost:8080/x?y=1')).toBe('http://localhost:8080/x?y=1');
    expect(normaliseUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/');
    // The window renders as "the app"; a remote page (which a committed dev.url could name) never loads in it.
    expect(normaliseUrl('https://staging.acme.dev')).toBeNull();
    expect(normaliseUrl('http://user:pw@localhost:3000')).toBeNull();
  });

  it('refuses anything that is not http(s)', () => {
    for (const bad of [
      'file:///etc/passwd',
      'app://styx/index.html',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'chrome://settings',
      '',
      '   ',
    ])
      expect(normaliseUrl(bad)).toBeNull();
  });
});

describe('preview device bounds', () => {
  const content = { width: 1280, height: 800 };

  it('trusts the rectangle the renderer reported (it owns the frame layout now)', () => {
    const slot = { x: 654, y: 100, width: 393, height: 600 };
    expect(deviceBounds(slot, content)).toEqual(slot);
  });

  it('clamps to the window so a rectangle hanging off the edge still shows what it can', () => {
    expect(deviceBounds({ x: 1100, y: 700, width: 393, height: 852 }, content)).toEqual({
      x: 1100,
      y: 700,
      width: 180,
      height: 100,
    });
    expect(deviceBounds({ x: -20, y: -10, width: 300, height: 400 }, content)).toEqual({
      x: 0,
      y: 0,
      width: 280,
      height: 390,
    });
    expect(deviceBounds({ x: 2000, y: 0, width: 100, height: 100 }, content)).toMatchObject({ width: 0 });
  });
});

describe('preview zoom', () => {
  it('desktop and a frame at full size are unzoomed', () => {
    expect(viewZoom({ x: 0, y: 0, width: 900, height: 700 }, 'desktop')).toBe(1);
    expect(viewZoom({ x: 0, y: 0, width: 393, height: 852 }, 'phone')).toBe(1);
    expect(viewZoom({ x: 0, y: 0, width: 400, height: 900 }, 'phone')).toBe(1);
  });

  it('a frame shrunk by the renderer zooms the page by the same factor, so the layout viewport stays the device', () => {
    // 393 × 0.55 = 216.15 → the view got 216 px: the factor is exactly 216 / 393, so the page measures 393.
    expect(viewZoom({ x: 0, y: 0, width: 216, height: 469 }, 'phone')).toBe(216 / 393);
    expect(Math.round(216 / viewZoom({ x: 0, y: 0, width: 216, height: 469 }, 'phone'))).toBe(393);
    // Rotated: the view's width is the device's height.
    expect(viewZoom({ x: 0, y: 0, width: 469, height: 216 }, 'phone')).toBe(469 / 852);
    expect(viewZoom({ x: 0, y: 0, width: 417, height: 556 }, 'tablet')).toBe(0.5);
    // A pixel lost to rounding still divides out to the device width.
    for (const w of [168, 169, 170])
      expect(Math.round(w / viewZoom({ x: 0, y: 0, width: w, height: 366 }, 'phone'))).toBe(393);
  });

  it('an empty rectangle is left alone', () => {
    expect(viewZoom({ x: 0, y: 0, width: 0, height: 0 }, 'phone')).toBe(1);
  });
});
