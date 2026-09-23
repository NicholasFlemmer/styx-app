import type { ReactNode } from 'react';
import { Section } from './Section';
import styles from './Ship.module.css';

/**
 * Everything between an agent finishing and the change being live. Added once the app grew these (discrepancy
 * #117): the site had stopped at "review the branch", and the app had carried on to running, landing,
 * publishing and deploying. Each claim sits under a small piece of the app that shows it, in the app's own
 * words (copy.ts: run, queue, checkpoints, publish, deploy, skills).
 */

const Running = () => (
  <>
    <div className={styles.bar}>
      <span className={styles.btn} data-inv="true">
        ■ Stop
      </span>
      <span className={styles.field}>pnpm dev</span>
      <span className={styles.chips}>
        <span data-inv="true">Desktop</span>
        <span>Tablet</span>
        <span>Phone</span>
      </span>
    </div>
    <div className={styles.page}>
      <div className={styles.url}>localhost:3000</div>
      <div className={styles.pageBody}>
        <i style={{ width: '38%' }} />
        <i style={{ width: '62%' }} />
        <i style={{ width: '54%' }} />
        <b />
      </div>
    </div>
    <div className={styles.status}>
      <span className={styles.dot} /> Running · localhost:3000
    </div>
  </>
);

const Queue = () => (
  <>
    <div className={styles.msg}>
      <span className={styles.who}>
        <span className={styles.dot} data-blink="true" /> Claude Code
      </span>
      Updating the totals in checkout.ts…
    </div>
    <div className={styles.mine}>
      <span className="tag">Queued</span>
      <span>also add a test for an empty cart</span>
    </div>
    <div className={styles.composer}>
      <span className={styles.typing}>and keep the old rounding for refunds</span>
      <span className={styles.chips}>
        <span data-inv="true">Queue</span>
        <span>Steer</span>
      </span>
    </div>
    <div className={styles.status}>Claude Code takes it after this turn.</div>
  </>
);

const turns = [
  ['Turn 2', '2 files · +18 −4'],
  ['Turn 3', '3 files · +6 −2'],
  ['Turn 4', '5 files · +96 −41'],
] as const;

const Undo = () => (
  <>
    {turns.map(([turn, changes], i) => {
      const last = i === turns.length - 1;
      return (
        <div key={turn} className={styles.turn} data-last={last || undefined}>
          <span className={styles.turnName}>{turn}</span>
          <span className={styles.muted}>{changes}</span>
          <span className={styles.btn} data-inv={last || undefined}>
            {last ? 'Revert this turn' : 'Review'}
          </span>
        </div>
      );
    })}
    <div className={styles.status}>Workspace restored to before turn 4.</div>
  </>
);

const Publish = () => (
  <>
    <div className={styles.label}>Publish · fix/checkout</div>
    <div className={styles.field} data-wide="true">
      Fix rounding in checkout totals
    </div>
    <div className={styles.chips}>
      <span>Commit &amp; push</span>
      <span data-inv="true">Commit, push &amp; open PR</span>
    </div>
    <ul className={styles.steps}>
      <li>✓ commit a41c9e2</li>
      <li>✓ push</li>
      <li>✓ PR #214</li>
    </ul>
  </>
);

const Deploy = () => (
  <>
    <span className={styles.btn} data-inv="true" data-big="true">
      ▲ Deploy to live · Vercel prod
    </span>
    <div className={styles.ask}>
      <span className={styles.label}>Production · deploy</span>
      <span>Touch ID to continue</span>
    </div>
    <ul className={styles.steps}>
      <li>vercel deploy --prod</li>
      <li>Deploying · Vercel prod…</li>
      <li>✓ Deployed · Vercel prod</li>
    </ul>
  </>
);

const hosts = [
  ['Claude', true],
  ['Codex', true],
  ['Gemini', false],
  ['Cursor', true],
] as const;

const Skills = () => (
  <>
    <div className={styles.skill}>
      <span className={styles.turnName}>release-notes</span>
      <span className={styles.tags}>
        <span className="tag">Claude</span>
        <span className="tag">Codex</span>
      </span>
    </div>
    <div className={styles.skill}>
      <span className={styles.turnName}>db-migrations</span>
      <span className={styles.tags}>
        <span className="tag">Shared</span>
      </span>
    </div>
    <div className={styles.label}>For</div>
    <div className={styles.checks}>
      {hosts.map(([name, on]) => (
        <span key={name}>
          <span className={styles.box} data-inv={on || undefined} />
          {name}
        </span>
      ))}
    </div>
    <span className={styles.btn} data-inv="true">
      Install
    </span>
  </>
);

const rows: readonly (readonly [string, string, ReactNode])[] = [
  [
    'See it running.',
    'Styx works out how to start your app and shows it next to the code, at desktop, tablet or phone size. The first time, an agent figures out the command, and Styx remembers it.',
    <Running key="run" />,
  ],
  [
    'Keep talking while it works.',
    'Type your next message while an agent is busy. It waits for the current turn to finish, or Codex takes it straight away.',
    <Queue key="queue" />,
  ],
  [
    'Undo a turn.',
    'Every turn an agent takes is saved. If one goes wrong, put the project back to how it was before it, in one click.',
    <Undo key="undo" />,
  ],
  [
    'Publish in one step.',
    'Commit, push and open a pull request together. A project that is not on GitHub yet can be connected from inside Styx.',
    <Publish key="publish" />,
  ],
  [
    'Deploy to live.',
    'One button, named for where it goes. It asks for your fingerprint first, the same as it would ask on an agent’s behalf.',
    <Deploy key="deploy" />,
  ],
  [
    'Skills for every agent.',
    'Install a skill once and choose which agents get it: Claude Code, Codex, Gemini CLI, Cursor, or all of them.',
    <Skills key="skills" />,
  ],
];

export const Ship = () => (
  <Section
    tone="panel"
    id="ship"
    title="From a finished branch to live, without leaving."
    lede="Once an agent is done, everything else happens in the same window too. Anything that reaches production still asks you first."
  >
    <ul className={styles.cards}>
      {rows.map(([claim, detail, shot]) => (
        <li key={claim}>
          <div className={styles.shot} aria-hidden="true">
            {shot}
          </div>
          <h3>{claim}</h3>
          <p>{detail}</p>
        </li>
      ))}
    </ul>
    <p className={styles.also}>
      Also in the app: a usage view that shows how close each agent is to its limit, background reviews of a
      project’s technical debt, and an agent dock that keeps every chat above your other windows.
    </p>
  </Section>
);
