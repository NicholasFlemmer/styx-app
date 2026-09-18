import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeviceFrame } from './DeviceFrame';

describe('DeviceFrame', () => {
  it('is a named group whose screen slot is exactly the size given', () => {
    render(
      <DeviceFrame kind="phone" width={393} height={852} label="Phone frame">
        <span>app</span>
      </DeviceFrame>,
    );
    const frame = screen.getByRole('group', { name: 'Phone frame' });
    expect(frame).toHaveAttribute('data-kind', 'phone');
    expect(frame).not.toHaveAttribute('data-landscape');
    const slot = frame.querySelector('[data-screen]');
    expect(slot).toHaveStyle({ width: '393px', height: '852px' });
    expect(slot).toContainElement(screen.getByText('app'));
  });
  it('the chrome is decorative: the clock and glyphs are hidden from assistive tech', () => {
    render(<DeviceFrame kind="phone" width={100} height={200} label="Phone frame" />);
    const clock = screen.getByText('9:41');
    expect(clock.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(document.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(3);
  });
  it('the phone has an island, the tablet does not; landscape is marked on the frame', () => {
    const { rerender } = render(<DeviceFrame kind="phone" width={100} height={200} label="Phone frame" />);
    expect(document.querySelector('[data-island]')).not.toBeNull();
    rerender(<DeviceFrame kind="tablet" landscape width={200} height={100} label="Tablet frame" />);
    expect(document.querySelector('[data-island]')).toBeNull();
    const frame = screen.getByRole('group', { name: 'Tablet frame' });
    expect(frame).toHaveAttribute('data-kind', 'tablet');
    expect(frame).toHaveAttribute('data-landscape', 'true');
  });
  it('forwards a ref, className and data attributes to the frame element', () => {
    let el: HTMLDivElement | null = null;
    render(
      <DeviceFrame
        ref={(n) => {
          el = n;
        }}
        kind="phone"
        width={1}
        height={1}
        label="Phone frame"
        className="x"
        data-preview-frame="phone"
      />,
    );
    expect(el).not.toBeNull();
    expect(el!).toHaveClass('x');
    expect(el!).toHaveAttribute('data-preview-frame', 'phone');
  });
});
