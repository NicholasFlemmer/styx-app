'use client';

import { useEffect, useState, type ReactNode } from 'react';
import styles from './Toc.module.css';

export interface TocItem {
  title: ReactNode;
  url: string;
  depth: number;
}

/** "On this page": the page's headings, the one being read marked as it scrolls past. */
export function Toc({ items, tools }: { items: TocItem[]; tools: ReactNode }) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const ids = items.map((i) => i.url.replace(/^#/, ''));
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => e !== null);
    if (els.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).map((e) => e.target.id);
        if (seen[0]) setActive(seen[0]);
      },
      { rootMargin: '-72px 0px -65% 0px' },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [items]);
  return (
    <aside className={styles.toc} aria-label="On this page">
      {items.length > 0 ? (
        <>
          <h2 className={styles.title}>On this page</h2>
          <ul>
            {items
              .filter((i) => i.depth <= 3)
              .map((i) => (
                <li key={i.url} data-depth={i.depth}>
                  <a href={i.url} aria-current={active === i.url.slice(1) ? 'location' : undefined}>
                    {i.title}
                  </a>
                </li>
              ))}
          </ul>
        </>
      ) : null}
      <div className={styles.tools}>{tools}</div>
    </aside>
  );
}
