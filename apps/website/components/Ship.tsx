import type { ReactNode } from 'react';
import { Section } from './Section';
import styles from './Ship.module.css';

/**
 * Everything between an agent finishing and the change being live. Added once the app grew these (discrepancy
 * #117): the site had stopped at "review the branch", and the app had carried on to running, publishing,
 * deploying and auditing. Three features get a row of their own with a drawing of the app beside them; three
 * smaller ones share a row of cards. (The Design tab row moved to DesignBuild, as Preview, in 0.4.) Drawings use the app's own words (copy.ts: design, publish, connectRepo,
 * deploy, debtAudit, queue, checkpoints, skills).
 */

/* ---------- The three large drawings ---------- */

const GithubShot = () => (
  <>
    <div className={styles.label}>Publish · fix/checkout</div>
    <div className={styles.note}>Drafted by Claude Code from the diff. Edit it before you send.</div>
    <div className={styles.area}>
      <strong>Fix rounding in checkout totals</strong>
      <span className={styles.muted}>
        Totals were rounded per line, so carts over ten items could be a cent out. Round once, at the end.
      </span>
    </div>
    <div className={styles.chips}>
      <span>Commit only</span>
      <span>Commit &amp; push</span>
      <span data-inv="true">Commit, push &amp; open PR</span>
    </div>
    <ul className={styles.steps}>
      <li>✓ commit a41c9e2 · .env left out</li>
      <li>✓ Brought in 3 commits from main · push</li>
      <li>✓ Opened PR #214</li>
    </ul>
    <div className={styles.audit}>
      <span>14:02</span>
      <span>github · write</span>
      <span className={styles.cmd}>you · published fix/checkout</span>
      <span>revoked</span>
    </div>
  </>
);

const deployRows = [
  ['Vercel', 'prod', 'built in · vercel deploy --prod'],
  ['GCP', 'prod', 'gcloud run deploy api --source .'],
  ['SSH', 'staging', "ssh box 'cd app && ./deploy.sh'"],
] as const;

const DeployShot = () => (
  <>
    <div className={styles.label}>Deploy commands</div>
    <div className={styles.table}>
      {deployRows.map(([target, env, command]) => (
        <div key={target} className={styles.row}>
          <span className={styles.strong}>{target}</span>
          <span className={styles.muted}>{env}</span>
          <span className={styles.cmd}>{command}</span>
        </div>
      ))}
    </div>
    <div className={styles.ask}>
      <span className={styles.label}>GCP prod · deploy</span>
      <span>Touch ID to continue</span>
    </div>
    <div className={styles.term}>
      <span>$ gcloud run deploy api --source .</span>
      <span>Building and deploying container…</span>
      <span>Revision api-00042 is serving 100% of traffic.</span>
      <span className={styles.strong}>✓ Deployed · GCP prod</span>
    </div>
  </>
);

const AuditShot = () => (
  <>
    <div className={styles.taskHead}>
      <span className={styles.label}>Tech debt audit · Claude Code</span>
      <span className={styles.muted}>Finished</span>
    </div>
    <div className={styles.report}>
      <p>
        <b>First hour</b> Mostly. The README says <code>npm start</code>; the script is called{' '}
        <code>dev</code>.
      </p>
      <p>
        <b>Will bite you</b>
      </p>
      <div className={styles.finding}>
        <strong>“Prices are stored in pounds.” They are stored in pence.</strong>
        <code>src/billing/totals.ts:88 · touched 14 times</code>
        <span>
          <em>Accident:</em> a new discount divides twice and every order is a hundred times too cheap.
        </span>
        <span>
          <em>Fix:</em> one Money type at the edge · S
        </span>
      </div>
      <p>
        <b>Untidy</b>
      </p>
      <code className={styles.cmd}>src/lib/date.ts — a second date helper, unused</code>
    </div>
  </>
);

/* ---------- The three small drawings ---------- */

const QueueShot = () => (
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

const UndoShot = () => (
  <>
    {turns.map(([turn, changes], i) => {
      const last = i === turns.length - 1;
      return (
        <div key={turn} className={styles.turn}>
          <span className={styles.strong}>{turn}</span>
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

const hosts = [
  ['Claude', true],
  ['Codex', true],
  ['Gemini', false],
  ['Cursor', true],
] as const;

const SkillsShot = () => (
  <>
    <div className={styles.skill}>
      <span className={styles.strong}>release-notes</span>
      <span className={styles.tags}>
        <span className="tag">Claude</span>
        <span className="tag">Codex</span>
      </span>
    </div>
    <div className={styles.skill}>
      <span className={styles.strong}>db-migrations</span>
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

/* ---------- Content ---------- */

type Feature = {
  readonly title: string;
  readonly body: string;
  readonly facts: readonly string[];
  readonly shot: ReactNode;
};

const features: readonly Feature[] = [
  {
    title: 'Straight to GitHub.',
    body: 'No repo yet? Create one, private by default, or link one you already have. Publish then commits, pushes and opens the pull request in one step, with the message drafted by your agent from the changes.',
    facts: [
      'It uses the GitHub login you already have on this machine.',
      'Files like .env and private keys are kept out of the commit.',
      'The push gets its own short-lived access, recorded in the log and thrown away when it finishes.',
    ],
    shot: <GithubShot />,
  },
  {
    title: 'Deploys the way you would do it yourself.',
    body: 'Each place you deploy to runs the command you’d type: vercel, gcloud, a script over ssh. You don’t have to know it. On the first deploy an agent works it out, and Styx remembers.',
    facts: [
      'Anything live asks for your fingerprint first.',
      'Progress stays on the button and in the status bar, so you can keep working.',
      'Every deploy is in the log: who asked, where it went, what ran and how it ended.',
    ],
    shot: <DeployShot />,
  },
  {
    title: 'Find what will slow the next person down.',
    body: 'Tech debt audit has an agent read your project the way a new engineer would, and report what will actually trip someone up. It runs in the background and changes nothing.',
    facts: [
      'Every finding names the file and line, the mistake it leads to, and the size of the fix.',
      'It checks your setup instructions against what the code really needs.',
      'Switch projects while it works; the report waits under Tasks.',
    ],
    shot: <AuditShot />,
  },
];

const cards = [
  [
    'Keep talking while it works.',
    'Type your next message while an agent is busy. It waits for the current turn to finish, or Codex takes it straight away.',
    <QueueShot key="queue" />,
  ],
  [
    'Undo a turn.',
    'Every turn an agent takes is saved. If one goes wrong, put the project back to how it was before it, in one click.',
    <UndoShot key="undo" />,
  ],
  [
    'Skills for every agent.',
    'Install a skill once and choose which agents get it: Claude Code, Codex, Gemini CLI, Cursor, or all of them.',
    <SkillsShot key="skills" />,
  ],
] as const;

export const Ship = () => (
  <Section
    id="ship"
    title="From a finished branch to live, without leaving."
    lede="Once an agent is done, everything else happens in the same window too. Anything that reaches production still asks you first."
  >
    <div className={styles.features}>
      {features.map((f, i) => (
        <article key={f.title} className={styles.feature} data-flip={i % 2 === 1 || undefined}>
          <div className={styles.copy}>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
            <ul>
              {f.facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>
          <div className={styles.shot} data-size="large" aria-hidden="true">
            {f.shot}
          </div>
        </article>
      ))}
    </div>
    <ul className={styles.cards}>
      {cards.map(([claim, detail, shot]) => (
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
      Also in the app: a usage view that shows how close each agent is to its limit, and an agent dock that
      keeps every chat above your other windows.
    </p>
  </Section>
);
