// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  PICKED_ATTR,
  buildSrcdoc,
  describeSelection,
  elementName,
  selectorOf,
  serializeForSave,
} from './design-doc';

const file = {
  path: 'checkout/desktop.html',
  screen: 'checkout',
  size: 'desktop',
  fidelity: 'hi',
  mtime: 0,
} as const;
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('design-doc (#140)', () => {
  it('draws a screen without scripts, with its tokens inlined in place of the link', () => {
    const src = buildSrcdoc(
      '<html><head><link rel="stylesheet" href="../tokens.css"></head><body><script>x()</script><p>Hi</p></body></html>',
      ':root{--color-primary:#2F5BFF}',
    );
    expect(src).not.toContain('<script');
    expect(src).not.toContain('tokens.css');
    expect(src).toContain('--color-primary:#2F5BFF');
    expect(buildSrcdoc('<p>bare</p>', 'x')).toContain('<body><p>bare</p></body>');
  });

  it('saves what the agent wrote plus the edit: the link back, Styx’s marks gone', () => {
    const doc = parse(
      buildSrcdoc(
        '<html><head><link rel="stylesheet" href="../tokens.css"></head><body><button id="pay">Pay</button></body></html>',
        'css',
      ),
    );
    const pay = doc.getElementById('pay');
    pay?.setAttribute(PICKED_ATTR, '');
    if (pay) pay.textContent = 'Pay now';
    const out = serializeForSave(doc);
    expect(out).toContain('<link rel="stylesheet" href="../tokens.css">');
    expect(out).toContain('>Pay now</button>');
    expect(out).not.toContain(PICKED_ATTR);
    expect(out).not.toContain('data-styx');
  });

  it('names elements in words and finds them again by selector', () => {
    const doc = parse(
      '<body><main><button id="pay-button">Pay</button><div class="totalRow">T</div><p>One</p><p>Two words here</p></main></body>',
    );
    expect(elementName(doc.getElementById('pay-button') as Element)).toBe('Pay button');
    expect(elementName(doc.querySelector('.totalRow') as Element)).toBe('Total row');
    expect(elementName(doc.querySelectorAll('p')[1] as Element)).toBe('p “Two words here”');
    expect(selectorOf(doc.querySelectorAll('p')[1] as Element)).toBe('body > main > p:nth-of-type(2)');
    expect(selectorOf(doc.getElementById('pay-button') as Element)).toBe('#pay-button');
  });

  it('describes an element and an area for the agent', () => {
    const doc = parse('<body><button id="pay">Pay</button><span class="logos">Visa</span></body>');
    const el = doc.getElementById('pay') as Element;
    const one = describeSelection({ kind: 'element', file, el, rect: new DOMRect(0, 0, 10, 10) });
    expect(one.label).toBe('Checkout › Pay');
    expect(one.detail).toContain('Screen: .styx/designs/checkout/desktop.html (Desktop, Hi-fi)');
    expect(one.detail).toContain('Element: #pay');
    const area = describeSelection({
      kind: 'area',
      file,
      els: [el, doc.querySelector('.logos') as Element],
      rect: { x: 1, y: 2, width: 236.4, height: 104 },
    });
    expect(area.label).toBe('Checkout › Area: Pay, Logos');
    expect(area.detail).toContain('An area 236 × 104 px');
  });
});
