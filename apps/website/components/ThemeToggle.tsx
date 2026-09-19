'use client';

import { useEffect, useSyncExternalStore } from 'react';
import styles from './ThemeToggle.module.css';

type Theme = 'dark' | 'light';

const STORAGE_KEY = 'styx-theme';

const readTheme = (): Theme => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

const subscribe = (onChange: () => void): (() => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
};

export const setTheme = (theme: Theme): void => {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private mode or blocked storage: the attribute still switches the page for this visit.
  }
};

export const toggleTheme = (): void => setTheme(readTheme() === 'dark' ? 'light' : 'dark');

/** The app's ⌘⇧T / Ctrl+Shift+T, honoured on the site too. */
const isThemeChord = (e: KeyboardEvent): boolean => (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 't';

export const ThemeToggle = () => {
  const theme = useSyncExternalStore(subscribe, readTheme, () => 'dark' as Theme);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isThemeChord(e)) return;
      e.preventDefault();
      toggleTheme();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className={styles.toggle} onClick={toggleTheme} aria-label={`Switch to ${next} theme`} title="⌘⇧T">
      <span className="sq" data-hollow={theme === 'light' ? 'true' : undefined} data-on={theme === 'dark' ? undefined : undefined} aria-hidden="true" />
      <span suppressHydrationWarning>{next === 'light' ? 'Light' : 'Dark'}</span>
    </button>
  );
};
