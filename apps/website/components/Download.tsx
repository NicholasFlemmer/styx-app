import { site } from '@/lib/site';
import { Section } from './Section';
import styles from './Download.module.css';

export const Download = () => (
  <Section tone="panel" id="download" title="Download" lede={`Beta ${site.version} for Mac and Windows.`}>
    <div className={styles.cards}>
      <div className={styles.card}>
        <h3>Mac</h3>
        <p className={styles.meta}>Touch ID for anything that touches production</p>
        <a className="btn" data-on="true" href={site.links.downloadMac}>
          Download for Mac
        </a>
      </div>
      <div className={styles.card}>
        <h3>Windows</h3>
        <p className={styles.meta}>
          Windows Hello for anything that touches production. Same app, same rules. Windows 10 and 11, x64.
        </p>
        <a className="btn" href={site.links.downloadWin}>
          Download for Windows
        </a>
        <p className={styles.meta}>
          Beta, not yet signed: Windows will say it doesn’t know the publisher. Choose More info, then Run
          anyway. It doesn’t update itself yet, so download it again for a newer version.
        </p>
      </div>
    </div>
    <p className={styles.note}>
      Styx works with the agents already installed on your computer. If one is missing, it tells you and
      points you to the install guide.
    </p>
  </Section>
);
