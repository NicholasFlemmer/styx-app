import { sections, site } from '@/lib/site';
import { ThemeToggle } from './ThemeToggle';
import { CookieSettingsLink } from './CookieSettingsLink';
import styles from './Footer.module.css';

export const Footer = () => (
  <footer className={styles.footer}>
    <div className={`wrap ${styles.support}`}>
      <p className={styles.supportText}>
        <strong>Styx is made by one person.</strong> If it saves you a context switch a day, a coffee keeps it
        going.
      </p>
      <a className="btn" data-on="true" href={site.links.support} target="_blank" rel="noopener noreferrer">
        Buy me a coffee ↗
      </a>
    </div>
    <div className={`wrap ${styles.inner}`}>
      <div className={styles.brand}>
        <span className={styles.wordmark}>STYX</span>
        <p>
          Named after the river everything must cross. Every project, every agent, every key, one window. Mac
          now, Windows soon.
        </p>
      </div>
      <nav aria-label="Footer" className={styles.links}>
        {sections.map((s) => (
          <a key={s.id} href={`/#${s.id}`}>
            {s.label}
          </a>
        ))}
      </nav>
      <div className={styles.meta}>
        <ThemeToggle />
        <nav aria-label="Legal" className={styles.legal}>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <CookieSettingsLink label="Cookie settings" />
        </nav>
        <span>© {new Date().getFullYear()} Styx</span>
      </div>
    </div>
  </footer>
);
