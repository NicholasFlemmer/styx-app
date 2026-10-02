import { describe, expect, it } from 'vitest';
import { describePick, PICK_SCRIPT, rawPickSchema, type PickedElement } from './preview-pick';

const el = (over: Partial<PickedElement> = {}): PickedElement => ({
  tag: 'button',
  id: '',
  classes: ['pay'],
  text: 'Pay €70',
  html: '<button class="pay">Pay €70</button>',
  component: 'PayButton',
  source: 'src/checkout.tsx:48',
  rect: { x: 10, y: 20, width: 222, height: 31 },
  ...over,
});

describe('preview pick (#140)', () => {
  it('an element: its component, tag and text as the label; source and markup for the agent', () => {
    const { label, detail } = describePick({ kind: 'element', path: '/checkout', rect: el().rect, items: [el()] });
    expect(label).toBe('PayButton › button.pay “Pay €70”');
    expect(detail).toContain('Page: /checkout');
    expect(detail).toContain('source: src/checkout.tsx:48');
    expect(detail).toContain('markup: <button class="pay">Pay €70</button>');
  });

  it('an area: its size and what it holds', () => {
    const { label, detail } = describePick({
      kind: 'area',
      path: '/',
      rect: { x: 0, y: 0, width: 400.4, height: 120 },
      items: [el({ tag: 'div', classes: ['row'], component: '', source: '', text: 'Total €70' }), el()],
    });
    expect(label).toBe('Area 400 × 120: div.row “Total €70”, PayButton › button.pay “Pay €70”');
    expect(detail).toContain('holding 2 element(s)');
  });

  it('refuses page data that does not fit the shape', () => {
    expect(rawPickSchema.safeParse({ kind: 'area', path: '/', rect: {}, items: [] }).success).toBe(false);
    expect(rawPickSchema.safeParse({ kind: 'element', path: '/', rect: el().rect, items: [el({ html: 'x'.repeat(5000) })] }).success).toBe(false);
  });

  it('the script parses', () => {
    expect(() => new Function(`return ${PICK_SCRIPT}`)).not.toThrow();
  });
});
