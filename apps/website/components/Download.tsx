import { site } from '@/lib/site';
import { Section } from './Section';
import styles from './Download.module.css';

export const Download = () => (
  <Section
    tone="panel"
    id="download"
    title="Download"
    lede={`Version ${site.version}, free and open source. For Mac, with Windows and Linux in beta.`}
  >
    <div className={styles.cards}>
      <div className={styles.card}>
        <h3>Mac</h3>
        <p className={styles.meta}>
          Touch ID for anything that touches production, or your Mac&apos;s password on one without it. Apple
          silicon.
        </p>
        <a className="btn" data-on="true" href={site.links.downloadMac}>
          Download
        </a>
      </div>
      <div className={styles.card}>
        <h3>Windows</h3>
        <p className={styles.meta}>
          Windows Hello for anything that touches production. Same app, same rules. Windows 10 and 11, x64.
        </p>
        <a className="btn" data-on="true" href={site.links.downloadWin}>
          Download
        </a>
      </div>
      <div className={styles.card}>
        <h3>Linux</h3>
        <p className={styles.meta}>
          Your system password for anything that touches production. An AppImage for any distribution, or a
          .deb for Debian and Ubuntu. x64.
        </p>
        <a
          className="btn"
          data-on="true"
          href={site.links.downloadLinux}
          target="_blank"
          rel="noopener noreferrer"
        >
          Download on GitHub ↗
        </a>
      </div>
    </div>
    <p className={styles.note}>
      Styx works with the agents already installed on your computer, and can install the ones you&apos;re
      missing. <a href="/docs/getting-started/install">Installing Styx</a> covers each platform, including
      what Linux needs.
    </p>
  </Section>
);
