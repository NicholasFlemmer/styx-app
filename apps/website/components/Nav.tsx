import { sections } from '@/lib/site';
import { DownloadButton } from './DownloadButton';
import { ThemeToggle } from './ThemeToggle';
import styles from './Nav.module.css';

const navIds = new Set(['how', 'access', 'agents', 'repo', 'ship', 'security']);

/** `current` marks the page's own item (Compare on the comparison pages); section anchors are never current. */
export const Nav = ({ current }: { current?: 'compare' } = {}) => (
  <header className={styles.nav} id="top" data-load="rule">
    <div className={`wrap ${styles.inner}`}>
      <a href="/" className={styles.wordmark}>
        STYX
      </a>
      <nav aria-label="Sections" className={styles.links}>
        {sections
          .filter((s) => navIds.has(s.id))
          .map((s) => (
            <a key={s.id} href={`/#${s.id}`}>
              {s.label}
            </a>
          ))}
        <a href="/compare" {...(current === 'compare' ? { 'aria-current': 'page' as const } : {})}>
          Compare
        </a>
      </nav>
      <div className={styles.right}>
        <ThemeToggle />
        <DownloadButton small primary={false} />
      </div>
    </div>
  </header>
);
