import type { ReactNode } from 'react';
import { Nav } from './Nav';
import { Footer } from './Footer';
import { legal } from '@/lib/legal';
import styles from './Legal.module.css';

/** A legal page: the site's nav and footer around one readable column. */
export const LegalPage = ({
  title,
  summary,
  children,
  meta = `Effective ${legal.effective}`,
  summaryLabel = 'In short',
  navCurrent,
}: {
  title: string;
  summary: ReactNode;
  children: ReactNode;
  /** The line under the title: the legal pages' effective date, or a comparison's "checked on". */
  meta?: string;
  summaryLabel?: string;
  navCurrent?: 'compare';
}) => (
  <>
    <a href="#main" className="srOnly">
      Skip to content
    </a>
    <Nav {...(navCurrent !== undefined ? { current: navCurrent } : {})} />
    <main id="main" className={styles.page}>
      <div className={`wrap ${styles.cols}`}>
        <header className={styles.head}>
          <h1>{title}</h1>
          <p className={styles.meta}>{meta}</p>
        </header>
        <div className={styles.body}>
          <aside className={styles.summary} aria-label={summaryLabel}>
            <h2>{summaryLabel}</h2>
            {summary}
          </aside>
          {children}
        </div>
      </div>
    </main>
    <Footer />
  </>
);
