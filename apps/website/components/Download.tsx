import { site } from '@/lib/site';
import { Section } from './Section';
import styles from './Download.module.css';

export const Download = () => (
  <Section id="download" title="Download" lede={`Beta ${site.version} for Mac. Windows is on its way. Nothing to sign up for.`}>
    <div className={styles.cards}>
      <div className={styles.card}>
        <h3>Mac</h3>
        <p className={styles.meta}>Touch ID for anything that touches production</p>
        <a className="btn" data-on="true" href={site.links.downloadMac}>
          Download for macOS
        </a>
      </div>
      <div className={styles.card} data-soon="true">
        <h3>Windows</h3>
        <p className={styles.soon}>Coming soon</p>
        <p className={styles.meta}>Windows Hello for anything that touches production. Same app, same rules.</p>
      </div>
    </div>
    <p className={styles.note}>
      Styx works with the agents already installed on your computer. If one is missing, it tells you and points you to
      the install guide.
    </p>
  </Section>
);
