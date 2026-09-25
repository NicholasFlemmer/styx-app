// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusBar } from './StatusBar';

describe('StatusBar', () => {
  afterEach(cleanup);

  it('ends with the Support Styx link (#120), a real button that opens the page', () => {
    const onOpen = vi.fn();
    render(
      <StatusBar
        branch="main"
        targets={[]}
        editor="Monaco · LF · TS"
        support={{ label: 'Support Styx', title: 'Buy me a coffee', onOpen }}
      />,
    );
    const link = screen.getByRole('button', { name: 'Support Styx ↗' });
    expect(link.getAttribute('title')).toBe('Buy me a coffee');
    expect(document.querySelector('[data-status-bar]')?.lastElementChild).toBe(link);
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('has no support link when none is given', () => {
    render(<StatusBar branch="main" targets={[]} editor="Monaco" />);
    expect(document.querySelector('[data-status-support]')).toBeNull();
  });
});
