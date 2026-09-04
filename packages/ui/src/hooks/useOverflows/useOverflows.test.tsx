import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { useOverflows } from './useOverflows';

function Box({ tall }: { tall: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const over = useOverflows(ref);
  return (
    <div ref={ref} data-testid="box" data-tall={tall} tabIndex={over ? 0 : undefined}>
      content
    </div>
  );
}

/** jsdom has no layout: fake the metrics on the prototype for the duration of a test. */
function withMetrics(scrollHeight: number, clientHeight: number, run: () => void) {
  const proto = HTMLElement.prototype;
  const sh = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
  const ch = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => clientHeight });
  try {
    run();
  } finally {
    if (sh) Object.defineProperty(proto, 'scrollHeight', sh);
    if (ch) Object.defineProperty(proto, 'clientHeight', ch);
  }
}

describe('useOverflows', () => {
  it('is false when the content fits', () => {
    withMetrics(100, 100, () => {
      render(<Box tall={0} />);
      expect(screen.getByTestId('box')).not.toHaveAttribute('tabindex');
    });
  });
  it('is true when scrollHeight exceeds clientHeight', () => {
    withMetrics(300, 100, () => {
      render(<Box tall={1} />);
      expect(screen.getByTestId('box')).toHaveAttribute('tabindex', '0');
    });
  });
});
