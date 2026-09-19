import type { ReactNode } from 'react';
import styles from './Screens.module.css';

export const SCREEN = { w: 1280, h: 800 } as const;

const navItems = [
  ['All projects', '5'],
  ['Workspace', ''],
  ['Agents', '3'],
  ['Repo', '4 wt'],
  ['Approvals', '3'],
  ['Settings', ''],
] as const;

type Props = { active: (typeof navItems)[number][0]; needsYou?: string; children: ReactNode };

/** Titlebar, rail and project nav shared by every screen mock, at the app's real sizes. */
export const AppChrome = ({ active, needsYou = '02', children }: Props) => (
  <div className={styles.app}>
    <div className={styles.titlebar}>
      <span className={styles.lights}>
        <span />
        <span />
        <span />
      </span>
      <span className={styles.wordmark}>STYX</span>
      <span className={styles.chip}>
        acme-shop <span className={styles.caret}>▾</span>
      </span>
      <span className={`${styles.branch} mono`}>fix/checkout</span>
      <span className={styles.palette}>
        <span>Switch, spawn, deploy, grant…</span>
        <span className="mono">⌘K</span>
      </span>
      <span className={styles.counter}>
        <span className="sq" data-on="true" /> {needsYou} needs you
      </span>
      <span className={styles.counter}>
        <span className="sq" data-hollow="true" /> 02 locked
      </span>
    </div>
    <div className={styles.body}>
      <div className={styles.rail}>
        <span className={styles.tile} data-on="true">
          AS
        </span>
        <span className={styles.tile}>
          BL <span className="sq" data-on="true" />
        </span>
        <span className={styles.tile}>IN</span>
        <span className={styles.tile}>CX</span>
        <span className={styles.tile}>SA</span>
        <span className={styles.tileAdd}>+</span>
      </div>
      <div className={styles.nav}>
        <div className={styles.navLabel}>acme-shop</div>
        {navItems.map(([label, count]) => (
          <div key={label} className={styles.navItem} data-inv={label === active ? 'true' : undefined}>
            <span>{label}</span>
            <span className="mono">{count}</span>
          </div>
        ))}
        <div className={`${styles.navFoot} mono`}>
          ~/code/acme-shop
          <br />2 grants active
        </div>
      </div>
      <div className={styles.content}>{children}</div>
    </div>
  </div>
);
