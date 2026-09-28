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
        support={{ label: '☕ Buy us a coffee', title: 'Buy me a coffee', onOpen }}
      />,
    );
    const link = screen.getByRole('button', { name: '☕ Buy us a coffee' });
    expect(link.getAttribute('title')).toBe('Buy me a coffee');
    expect(document.querySelector('[data-status-bar]')?.lastElementChild).toBe(link);
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('has no support link when none is given', () => {
    render(<StatusBar branch="main" targets={[]} editor="Monaco" />);
    expect(document.querySelector('[data-status-support]')).toBeNull();
  });

  it('Feedback sits just before the coffee chip and opens the dialog (#123)', () => {
    const onFeedback = vi.fn();
    render(
      <StatusBar
        branch="main"
        targets={[]}
        editor="Monaco"
        feedback={{ label: 'Feedback', title: 'Tell me', onOpen: onFeedback }}
        support={{ label: '☕ Buy us a coffee', title: 'Buy me a coffee', onOpen: vi.fn() }}
      />,
    );
    const button = screen.getByRole('button', { name: 'Feedback' });
    expect(button.nextElementSibling?.getAttribute('data-status-support')).toBe('true');
    fireEvent.click(button);
    expect(onFeedback).toHaveBeenCalledTimes(1);
  });
});
