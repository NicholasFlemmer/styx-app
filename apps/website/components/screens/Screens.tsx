import { AppChrome } from './AppChrome';
import styles from './Screens.module.css';

const Btn = ({ children, inv, on }: { children: string; inv?: boolean; on?: boolean }) => (
  <span className={styles.btn} data-inv={inv ? 'true' : undefined} data-on={on ? 'true' : undefined}>
    {children}
  </span>
);

export const HomeScreen = () => (
  <AppChrome active="All projects">
    <div className={styles.counters}>
      {[
        ['02', 'Needs you'],
        ['03', 'Agents working'],
        ['02', 'Grants active'],
        ['05', 'Projects'],
      ].map(([n, l]) => (
        <div key={l}>
          <span className={styles.numeral}>{n}</span>
          <span className="label">{l}</span>
        </div>
      ))}
    </div>
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Project</th>
          <th>Path</th>
          <th>Branch</th>
          <th>Agents</th>
          <th>Targets</th>
          <th>Last activity</th>
        </tr>
      </thead>
      <tbody>
        {(
          [
            [
              'acme-shop',
              '~/code/acme-shop',
              'fix/checkout',
              'Claude, Codex, Gemini',
              'Vercel, Supabase, AWS, GitHub',
              '2m',
              true,
            ],
            ['blog-v2', '~/code/blog-v2', 'feat/mdx', 'Claude', 'Vercel, GitHub', '9m', true],
            ['infra-tools', '~/code/infra-tools', 'main', 'Gemini', 'AWS, GCP', '31m', false],
            ['client-x', '~/work/client-x', 'main', 'shell', 'GCP, GitHub', '1h', false],
            ['side-api', '~/code/side-api', 'main', '—', 'Supabase', '2d', false],
          ] as const
        ).map(([name, path, branch, agents, targets, t, on]) => (
          <tr key={name}>
            <td>
              <span className="sq" data-on={on ? 'true' : undefined} data-hollow={on ? undefined : 'true'} />{' '}
              <strong>{name}</strong>
            </td>
            <td className="mono">{path}</td>
            <td className="mono">{branch}</td>
            <td>{agents}</td>
            <td className={styles.muted}>{targets}</td>
            <td className="mono">{t}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <div className={styles.row}>
      <Btn>+ New project</Btn>
      <Btn>+ Open folder</Btn>
      <Btn>+ Clone URL</Btn>
    </div>
    <div className={styles.block}>
      <div className="label">Activity</div>
      <div className={`${styles.activity} mono`}>
        <div>
          <span>2m</span>
          <span>Claude</span>
          <span>acme-shop · edited checkout.ts, pay.ts · 42 tests pass</span>
        </div>
        <div>
          <span>3m</span>
          <span>Codex</span>
          <span>acme-shop · requested Supabase prod write</span>
        </div>
        <div>
          <span>9m</span>
          <span>Claude</span>
          <span>blog-v2 · plan ready, 4 files</span>
        </div>
        <div>
          <span>1h</span>
          <span>system</span>
          <span>revoked Gemini → AWS acme-prod (idle 1h)</span>
        </div>
      </div>
    </div>
  </AppChrome>
);

type Card = readonly [
  agent: string,
  branch: string,
  meta: string,
  action: string,
  second: string,
  on: boolean,
];
const columns: ReadonlyArray<readonly [title: string, n: string, cards: readonly Card[]]> = [
  ['Needs you', '1', [['Codex', 'test/flaky', '“migration 0042” · 3m', 'Review grant', 'Deny', true]]],
  [
    'Working',
    '2',
    [
      ['Claude', 'fix/checkout', 'editing pay.ts · 42 tests pass', 'Open', '', false],
      ['Gemini', 'docs/readme', 'rewriting README · 31m', 'Open', '', false],
    ],
  ],
  ['Done', '3', [['Cursor', 'feat/mdx', 'PR #212 merged · 1d', 'Archive', '', false]]],
];

export const AgentsScreen = () => (
  <AppChrome active="Agents">
    <div className={styles.board}>
      {columns.map(([title, n, cards]) => (
        <div key={title} className={styles.column}>
          <div className={styles.columnHead}>
            <span className="label">
              {title} · {n}
            </span>
          </div>
          {cards.map(([agent, branch, meta, a1, a2, on]) => (
            <div key={agent} className={styles.card} data-on={on ? 'true' : undefined}>
              <div className={styles.cardTop}>
                <strong>{agent}</strong>
                <span className="mono">{branch}</span>
                {on && (
                  <span className="tag" data-on="true">
                    needs you
                  </span>
                )}
              </div>
              <div className={`${styles.muted} mono`}>{meta}</div>
              <div className={styles.row}>
                <Btn on={on}>{a1}</Btn>
                {a2 && <Btn>{a2}</Btn>}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
    <div className={styles.row}>
      <Btn>+ Spawn agent</Btn>
    </div>
  </AppChrome>
);

export const RepoScreen = () => (
  <AppChrome active="Repo">
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Branch</th>
          <th>Owner</th>
          <th>Changes</th>
          <th>PR</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {(
          [
            ['main', 'you', '—', '—', ''],
            ['fix/checkout', 'Claude', '+142 −38 · 3 files', '#214 open', 'Review'],
            ['test/flaky', 'Codex', '+12 −4 · 2 files', '—', 'Open'],
            ['docs/readme', 'Gemini', 'conflict · README.md', '—', 'Resolve'],
          ] as const
        ).map(([b, o, c, pr, a]) => (
          <tr key={b} data-inv={b === 'fix/checkout' ? 'true' : undefined}>
            <td className="mono">{b}</td>
            <td>{o}</td>
            <td className="mono">{c}</td>
            <td className="mono">{pr}</td>
            <td>{a && <Btn inv={a === 'Review'}>{a}</Btn>}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <div className={styles.block}>
      <div className="label">fix/checkout · src/checkout.ts</div>
      <div className={`${styles.diff} mono`}>
        <div>
          {'  '}export async function checkout(cart) {'{'}
        </div>
        <div data-add="true">+ validate(cart)</div>
        <div>{'    '}const total = sum(cart.items)</div>
        <div>{'    '}const receipt = await pay(total)</div>
        <div data-add="true">+ audit(receipt)</div>
        <div>{'    '}return receipt</div>
      </div>
    </div>
  </AppChrome>
);

export const ApprovalsScreen = () => (
  <AppChrome active="Approvals">
    <div className={styles.split}>
      <div>
        <div className={styles.tabs}>
          <span data-inv="true">Inbox · 3</span>
          <span>Policies</span>
          <span>Audit log</span>
        </div>
        {(
          [
            ['Codex', 'acme-shop', 'Supabase prod', 'prod', 'write', '“migration 0042” · 3m'],
            ['Claude', 'infra-tools', 'AWS acme-prod', 'prod', 'read', '“list ECS services” · 9m'],
            ['Cursor', 'blog-v2', 'Vercel', 'preview', 'deploy', '“preview deploy for #88” · 14m'],
          ] as const
        ).map(([agent, project, target, env, scope, meta]) => (
          <div key={agent} className={styles.inboxRow}>
            <div>
              <strong>{agent}</strong> <span className={styles.muted}>{project}</span> →{' '}
              <strong>{target}</strong>{' '}
              <span className="tag" data-on={env === 'prod' ? 'true' : undefined}>
                {env}
              </span>{' '}
              <span className="tag">{scope}</span>
              <div className={`${styles.muted} mono`}>{meta}</div>
            </div>
            <div className={styles.row}>
              <Btn inv>Review</Btn>
              <Btn>Deny</Btn>
            </div>
          </div>
        ))}
        <div className={`${styles.muted} mono ${styles.pad}`}>
          auto-approved today: 12 (preview deploys, github reads)
        </div>
      </div>
      <div className={styles.side}>
        <div className="label">Policies</div>
        {(
          [
            ['Auto-approve read on any staging or preview target', 'matches 12 today', false],
            ['Always ask, require Touch ID / Windows Hello for prod write', 'matches 2 today', true],
            ['Expire grants after 1h idle', 'revoked 5 this week', true],
          ] as const
        ).map(([t, m, on]) => (
          <div key={t} className={styles.policy}>
            <span className={styles.check} data-on={on ? 'true' : undefined} />
            <div>
              {t}
              <div className={`${styles.muted} mono`}>{m}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  </AppChrome>
);

export const SettingsScreen = () => (
  <AppChrome active="Settings">
    <div className={styles.settings}>
      <div className={styles.settingsNav}>
        <div className="label">App</div>
        <div>Editor</div>
        <div>Agents</div>
        <div>Notifications</div>
        <div className="label">Project</div>
        <div data-inv="true">Targets</div>
        <div>Policies</div>
        <div>Skills</div>
      </div>
      <div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Target</th>
              <th>Env</th>
              <th>Policy</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['Vercel', 'prod', 'Ask · MFA', 'open · 58m left', 'Revoke', true],
                ['Supabase / prod db', 'prod', 'Ask · MFA', 'locked', 'Edit', false],
                ['AWS acme-prod', 'prod', 'Ask · MFA', 'expired', 'Refresh', false],
                ['GitHub', '—', 'Always allow', 'persistent', 'Edit', false],
              ] as const
            ).map(([t, e, p, s, a, on]) => (
              <tr key={t}>
                <td>
                  <strong>{t}</strong>
                </td>
                <td>
                  <span className="tag" data-on={e === 'prod' ? 'true' : undefined}>
                    {e}
                  </span>
                </td>
                <td>{p}</td>
                <td className="mono">
                  <span
                    className="sq"
                    data-on={on ? 'true' : undefined}
                    data-hollow={on ? undefined : 'true'}
                  />{' '}
                  {s}
                </td>
                <td>
                  <Btn>{a}</Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className={styles.row}>
          <Btn>+ Connect target · OAuth / key / SSH</Btn>
        </div>
      </div>
    </div>
  </AppChrome>
);

const hunks: ReadonlyArray<readonly [title: string, lines: readonly string[]]> = [
  [
    'checkout.ts · hunk 1 of 2',
    ['  import { sum } from "./cart"', '+ import { validate } from "./validate"'],
  ],
  [
    'checkout.ts · hunk 2 of 2',
    ['  export async function checkout(cart) {', '+   validate(cart)', '    const total = sum(cart.items)'],
  ],
];

export const DiffScreen = () => (
  <AppChrome active="Workspace" needsYou="01">
    <div className={styles.split}>
      <div className={styles.filesCol}>
        <div className="label">3 hunks from Claude · 42 tests pass</div>
        {['checkout.ts · 2', 'pay.ts · 1', 'validate.ts · new'].map((f, i) => (
          <div key={f} className={`${styles.fileRow} mono`} data-inv={i === 0 ? 'true' : undefined}>
            {f}
          </div>
        ))}
      </div>
      <div>
        {hunks.map(([title, lines]) => (
          <div key={title} className={styles.hunk}>
            <div className={styles.hunkHead}>
              <span className="label">{title}</span>
              <span className={styles.row}>
                {/* The app's own verbs: the agent's edit is already applied, so a hunk is kept by default and undone with r. */}
                <span className="label">applied</span>
                <Btn>r · Revert</Btn>
              </span>
            </div>
            <div className={`${styles.diff} mono`}>
              {lines.map((l) => (
                <div key={l} data-add={l.startsWith('+') ? 'true' : undefined}>
                  {l}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className={`${styles.muted} mono ${styles.pad}`}>r revert · j / k next · previous · ⌘⏎ done</div>
      </div>
    </div>
  </AppChrome>
);

export const OnboardingScreen = () => (
  <div className={styles.app}>
    <div className={styles.onboarding}>
      <div className={styles.steps}>
        {['Editor', 'Projects', 'Agents', 'Targets'].map((s, i) => (
          <span key={s} data-inv={i === 0 ? 'true' : undefined}>
            {String(i + 1).padStart(2, '0')} {s}
          </span>
        ))}
      </div>
      <h2 className={styles.onboardingTitle}>Connect your editor.</h2>
      <p className={styles.onboardingBody}>
        Styx embeds its own editor for reviewing and editing agent work. Connecting your IDE imports recents,
        keybindings and theme, and sets where “Open in…” goes. Nothing in your IDE changes.
      </p>
      <table className={styles.table}>
        <tbody>
          {(
            [
              ['VS Code', '1.104 · 23 recent folders', 'Detected', true],
              ['Cursor', '1.6 · 9 recent folders', 'Detected', false],
              ['WebStorm', '2026.2 · 4 recent projects', 'Detected', false],
              ['Neovim', '0.11', 'Fallback · Open in', false],
            ] as const
          ).map(([n, m, s, on]) => (
            <tr key={n}>
              <td>
                <strong>{n}</strong>
              </td>
              <td className={`${styles.muted} mono`}>{m}</td>
              <td>
                <span className="tag" data-on={on ? 'true' : undefined}>
                  {s}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.imports}>
        {[
          'Import keybindings',
          'Import theme & font',
          'Import recent folders (feeds next step)',
          'Install “Open in Styx” command',
        ].map((l, i) => (
          <div key={l} className={styles.policy}>
            <span className={styles.check} data-on={i < 3 ? 'true' : undefined} /> {l}
          </div>
        ))}
      </div>
      <div className={styles.row}>
        <Btn on>Continue</Btn>
        <Btn>Skip</Btn>
      </div>
    </div>
  </div>
);
