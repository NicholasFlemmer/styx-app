import { describe, expect, it } from 'vitest';
import { deviceBounds, normaliseUrl } from './preview-service';

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

  it('keeps an explicit http or https URL as given', () => {
    expect(normaliseUrl('https://staging.acme.dev')).toBe('https://staging.acme.dev/');
    expect(normaliseUrl('http://localhost:8080/x?y=1')).toBe('http://localhost:8080/x?y=1');
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
  const pane = { x: 400, y: 100, width: 900, height: 700 };

  it('desktop fills the pane', () => {
    expect(deviceBounds(pane, 'desktop')).toEqual(pane);
  });

  it('a preset makes the view genuinely that size, centred in the pane', () => {
    const phone = deviceBounds(pane, 'phone');
    expect(phone.width).toBe(393);
    // Centred horizontally: (900 - 393) / 2 = 253.5 → 400 + 253.5
    expect(phone.x).toBe(654);
    expect(phone.height).toBe(700); // the pane is shorter than the phone, so height clamps
  });

  it('clamps to the pane so a narrow pane still shows something', () => {
    const narrow = deviceBounds({ x: 0, y: 0, width: 300, height: 400 }, 'tablet');
    expect(narrow).toEqual({ x: 0, y: 0, width: 300, height: 400 });
  });
});
