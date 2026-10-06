'use client';

import { useDocsSearch } from 'fumadocs-core/search/client';
import { staticClient } from 'fumadocs-core/search/client/orama-static';
import { useEffect, useId, useRef, useState } from 'react';
import styles from './Search.module.css';

/** Markdown emphasis and code marks in an indexed snippet, which read as noise in a result. */
const plain = (s: string): string => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ');

/** Split on the `<mark>` Fumadocs puts around matches: the text shown plainly, each match in bold. */
const parts = (s: string): { text: string; hit: boolean }[] =>
  s
    .split(/(<mark>.*?<\/mark>)/g)
    .filter(Boolean)
    .map((p) =>
      p.startsWith('<mark>') ? { text: plain(p.slice(6, -7)), hit: true } : { text: plain(p), hit: false },
    );

/**
 * ⌘K / Ctrl+K search over every docs page, heading and paragraph. The index is a static file (/docs/search) built
 * with the site, downloaded on first open: it works offline once loaded and needs no server.
 */
export function Search() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const { search, setSearch, query } = useDocsSearch({ client: staticClient({ from: '/docs/search' }) });
  const results = query.data === 'empty' || query.data === undefined ? [] : query.data.slice(0, 12);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) {
      d.close();
      opener.current?.focus();
    }
  }, [open]);

  const go = (url: string) => {
    setOpen(false);
    window.location.href = url;
  };

  return (
    <>
      <button
        ref={opener}
        type="button"
        className={styles.open}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M9.5 9.5 13 13" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        <span className={styles.label}>Search the docs</span>
        <kbd className={styles.kbd}>⌘K</kbd>
      </button>
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-label="Search the docs"
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === dialog.current) setOpen(false);
        }}
      >
        {open ? (
          <div className={styles.panel}>
            <input
              autoFocus
              className={styles.input}
              type="search"
              placeholder="Search the docs"
              value={search}
              role="combobox"
              aria-expanded={results.length > 0}
              aria-controls={listId}
              aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
              onChange={(e) => {
                setSearch(e.currentTarget.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, results.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === 'Enter' && results[active]) {
                  e.preventDefault();
                  go(results[active].url);
                }
              }}
            />
            <ul id={listId} role="listbox" className={styles.list} aria-label="Results">
              {results.map((r, i) => (
                <li
                  key={r.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-inv={i === active ? 'true' : undefined}
                  data-kind={r.type}
                  className={styles.item}
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(r.url)}
                >
                  <span className={styles.text}>
                    {parts(r.content).map((p, j) =>
                      p.hit ? <b key={j}>{p.text}</b> : <span key={j}>{p.text}</span>,
                    )}
                  </span>
                  {r.breadcrumbs?.length ? <small>{r.breadcrumbs.join(' / ')}</small> : null}
                </li>
              ))}
              {search !== '' && !query.isLoading && results.length === 0 ? (
                <li className={styles.empty}>No results for “{search}”.</li>
              ) : null}
            </ul>
            <p className={styles.hint}>
              <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>⏎</kbd> to open · <kbd>Esc</kbd> to close
            </p>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
