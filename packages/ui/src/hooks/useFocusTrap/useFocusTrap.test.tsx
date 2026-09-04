import { useRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useFocusTrap } from './useFocusTrap';

function Trap({ active = true, initial }: { active?: boolean; initial?: 'first' | 'second' }) {
  const ref = useRef<HTMLDivElement>(null);
  const second = useRef<HTMLButtonElement>(null);
  useFocusTrap(ref, { active, initialFocus: initial === 'second' ? second : 'first' });
  return (
    <>
      <button>outside</button>
      <div ref={ref} tabIndex={-1} data-testid="root">
        <button>one</button>
        <button ref={second}>two</button>
        <button>three</button>
      </div>
    </>
  );
}

describe('useFocusTrap', () => {
  it('focuses the first tabbable on activate', () => {
    render(<Trap />);
    expect(screen.getByText('one')).toHaveFocus();
  });

  it('focuses the given ref when initialFocus is a ref', () => {
    render(<Trap initial="second" />);
    expect(screen.getByText('two')).toHaveFocus();
  });

  it('wraps Tab from last to first and Shift+Tab from first to last', async () => {
    const user = userEvent.setup();
    render(<Trap />);
    await user.tab();
    await user.tab();
    expect(screen.getByText('three')).toHaveFocus();
    await user.tab();
    expect(screen.getByText('one')).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByText('three')).toHaveFocus();
  });

  it('does nothing while inactive', async () => {
    const user = userEvent.setup();
    render(<Trap active={false} />);
    expect(screen.getByText('one')).not.toHaveFocus();
    await user.tab();
    expect(screen.getByText('outside')).toHaveFocus();
  });
});
