'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import styles from './Sidebar.module.css';

export interface NavSection {
  title: string | null;
  items: { name: string; url: string }[];
}

/**
 * The docs navigation: one group per folder, the current page inverted (`data-inv`). On a phone it folds away behind
 * a Menu button and opens over the page; picking a page closes it.
 */
export function Sidebar({ sections }: { sections: NavSection[] }) {
  const path = usePathname().replace(/\/$/, '') || '/docs';
  const [open, setOpen] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- a new page closes the phone menu
  useEffect(() => setOpen(false), [path]);
  return (
    <>
      <button
        type="button"
        className={styles.menu}
        aria-expanded={open}
        aria-controls="docs-nav"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Close' : 'Menu'}
      </button>
      <nav id="docs-nav" className={styles.side} aria-label="Docs" data-open={open ? 'true' : undefined}>
        {sections.map((s, i) => (
          <div key={s.title ?? i} className={styles.group}>
            {s.title ? <h2 className={styles.title}>{s.title}</h2> : null}
            <ul>
              {s.items.map((it) => (
                <li key={it.url}>
                  <a
                    href={it.url}
                    data-inv={it.url === path ? 'true' : undefined}
                    aria-current={it.url === path ? 'page' : undefined}
                  >
                    {it.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
}
