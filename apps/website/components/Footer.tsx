import { sections } from '@/lib/site';
import { ThemeToggle } from './ThemeToggle';
import styles from './Footer.module.css';

export const Footer = () => (
  <footer className={styles.footer}>
    <div className={`wrap ${styles.inner}`}>
      <div className={styles.brand}>
        <span className={styles.wordmark}>STYX</span>
        <p>Named after the river everything must cross. Every project, every agent, every key, one window. Mac now, Windows soon.</p>
      </div>
      <nav aria-label="Footer" className={styles.links}>
        {sections.map((s) => (
          <a key={s.id} href={`#${s.id}`}>
            {s.label}
          </a>
        ))}
      </nav>
      <div className={styles.meta}>
        <ThemeToggle />
        <span>© {new Date().getFullYear()} Styx</span>
      </div>
    </div>
  </footer>
);
