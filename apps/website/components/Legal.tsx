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
}: {
  title: string;
  summary: ReactNode;
  children: ReactNode;
}) => (
  <>
    <a href="#main" className="srOnly">
      Skip to content
    </a>
    <Nav />
    <main id="main" className={styles.page}>
      <div className={`wrap ${styles.cols}`}>
        <header className={styles.head}>
          <h1>{title}</h1>
          <p className={styles.meta}>Effective {legal.effective}</p>
        </header>
        <div className={styles.body}>
          <aside className={styles.summary} aria-label="In short">
            <h2>In short</h2>
            {summary}
          </aside>
          {children}
        </div>
      </div>
    </main>
    <Footer />
  </>
);
