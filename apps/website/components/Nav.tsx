import { sections, site } from '@/lib/site';
import { DownloadButton } from './DownloadButton';
import { ThemeToggle } from './ThemeToggle';
import styles from './Nav.module.css';

const navIds = new Set(['how', 'access', 'agents', 'repo', 'design', 'ship', 'security']);

/** `current` marks the page's own item (Story, Compare); section anchors are never current. */
export const Nav = ({ current }: { current?: 'launch' | 'story' | 'compare' } = {}) => (
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
        <a href="/launch" {...(current === 'launch' ? { 'aria-current': 'page' as const } : {})}>
          Launch
        </a>
        <a href="/story" {...(current === 'story' ? { 'aria-current': 'page' as const } : {})}>
          Story
        </a>
        <a href="/compare" {...(current === 'compare' ? { 'aria-current': 'page' as const } : {})}>
          Compare
        </a>
        <a href="/docs">Docs</a>
        <a href={site.links.github}>GitHub</a>
      </nav>
      <div className={styles.right}>
        <ThemeToggle />
        <DownloadButton small primary={false} />
      </div>
    </div>
  </header>
);
