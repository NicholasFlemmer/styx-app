import { DownloadButton } from './DownloadButton';
import { WorkspaceDemo } from './WorkspaceDemo';
import styles from './Hero.module.css';

export const Hero = () => (
  <section className={styles.hero} aria-labelledby="hero-title">
    <div className={`wrap ${styles.grid}`}>
      <div className={styles.copy}>
        <h1 id="hero-title" className={styles.h1}>
          <span>Every project.</span> <span>Every agent.</span> <span>Every key.</span>{' '}
          <span>One window.</span>
        </h1>
        <p className={styles.lede}>
          Styx is where everything converges: every repo you work in, the AI agents building in them, and
          every login they need to ship. Switch between all of it from one window. And like the river
          it&apos;s named after, nothing crosses over without you. Deploying, or touching live data, asks you
          first.
        </p>
        <div className={styles.ctas}>
          <DownloadButton note />
          <a href="#access" className={styles.secondary}>
            What happens at the crossing
          </a>
        </div>
        <p className={styles.micro}>
          Mac now, Windows soon. Your keys never leave your computer.
        </p>
      </div>
      <div className={styles.demo} data-load="fade">
        <WorkspaceDemo />
      </div>
    </div>
  </section>
);
