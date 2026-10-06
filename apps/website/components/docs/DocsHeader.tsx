import { DownloadButton } from '../DownloadButton';
import { ThemeToggle } from '../ThemeToggle';
import { Search } from './Search';
import styles from './DocsHeader.module.css';

const LINKS = [
  { href: '/docs', label: 'Docs', section: '' },
  { href: '/docs/guides/two-agents-one-feature', label: 'Guides', section: 'guides' },
  { href: '/docs/reference/settings', label: 'Reference', section: 'reference' },
  { href: '/docs/contributing/how-styx-is-built', label: 'Contributing', section: 'contributing' },
] as const;

/** The docs' top bar: the site's wordmark and theme toggle, docs sections, search and Download. */
export const DocsHeader = () => (
  <header className={styles.bar}>
    <div className={styles.inner}>
      <a href="/" className={styles.word}>
        STYX
      </a>
      <a href="/docs" className={styles.docs}>
        Docs
      </a>
      <nav aria-label="Docs sections" className={styles.links}>
        {LINKS.slice(1).map((l) => (
          <a key={l.href} href={l.href}>
            {l.label}
          </a>
        ))}
        <a href="https://github.com/NicholasFlemmer/styx-app">GitHub</a>
      </nav>
      <div className={styles.right}>
        <Search />
        <ThemeToggle />
        <span className={styles.download}>
          <DownloadButton small primary={false} />
        </span>
      </div>
    </div>
  </header>
);
