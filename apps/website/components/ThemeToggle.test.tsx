// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeToggle } from './ThemeToggle';

describe('ThemeToggle', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.clear();
  });
  afterEach(cleanup);

  it('offers the other theme and switches the html attribute on click', async () => {
    render(<ThemeToggle />);
    const button = screen.getByRole('button', { name: 'Switch to light theme' });
    fireEvent.click(button);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('styx-theme')).toBe('light');
    // The label follows the attribute through a MutationObserver, which delivers asynchronously.
    expect(await screen.findByRole('button', { name: 'Switch to dark theme' })).toBeTruthy();
  });

  it('honours the app’s ⌘⇧T chord', () => {
    render(<ThemeToggle />);
    fireEvent.keyDown(window, { key: 'T', metaKey: true, shiftKey: true });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    fireEvent.keyDown(window, { key: 't', ctrlKey: true, shiftKey: true });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('ignores other chords', () => {
    render(<ThemeToggle />);
    fireEvent.keyDown(window, { key: 't', metaKey: true });
    fireEvent.keyDown(window, { key: 'k', metaKey: true, shiftKey: true });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
