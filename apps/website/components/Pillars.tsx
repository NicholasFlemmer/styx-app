import styles from './Pillars.module.css';

const projects = [
  { initials: 'AS', name: 'acme-shop', meta: 'fix/checkout · 3 agents', needsYou: true, current: true },
  { initials: 'BL', name: 'blog-v2', meta: 'feat/mdx · Claude', needsYou: true, current: false },
  { initials: 'IN', name: 'infra-tools', meta: 'main · Gemini', needsYou: false, current: false },
  { initials: 'CX', name: 'client-x', meta: 'main · shell', needsYou: false, current: false },
  { initials: 'SA', name: 'side-api', meta: 'main', needsYou: false, current: false },
] as const;

/** The three things Styx does, each with a fragment of the surface that does it. */
export const Pillars = () => (
  <section id="how" className="section" aria-labelledby="how-title">
    <h2 id="how-title" className="srOnly">
      How it works
    </h2>
    <div className={`wrap ${styles.cols}`}>
      <div className={styles.col}>
        <h3>Every project</h3>
        <p>
          All your repos in one window, each with its own agents, branches and services. A glance shows what
          needs you; one keystroke takes you there. No more hunting through windows and terminals.
        </p>
        <div className={styles.art} aria-hidden="true">
          <div className={styles.switcher}>
            <div className={styles.paletteField}>
              <span>Switch, spawn, deploy, grant…</span>
              <span className="mono">⌘K</span>
            </div>
            {projects.map((p) => (
              <div key={p.name} className={styles.project} data-inv={p.current ? 'true' : undefined}>
                <span className={styles.tile} data-on={p.current ? 'true' : undefined}>
                  {p.initials}
                </span>
                <span className={styles.projectName}>{p.name}</span>
                <span className={`${styles.projectMeta} mono`}>{p.meta}</span>
                <span
                  className="sq"
                  data-on={p.needsYou ? 'true' : undefined}
                  data-hollow={p.needsYou ? undefined : 'true'}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className={styles.col}>
        <h3>Every agent</h3>
        <p>
          Claude Code, Codex, Gemini and Cursor, side by side, each on its own copy of your code. Read what
          they did, change by change, keep what you like, or open it in your own editor with one key.
        </p>
        <div className={styles.art} aria-hidden="true">
          <div className={styles.board}>
            <div className={styles.boardHead}>
              <span>
                <span className="sq" data-on="true" /> Needs you 1
              </span>
              <span>Working 2</span>
              <span>Done 3</span>
            </div>
            <div className={styles.card}>
              <div className={styles.cardTop}>
                <strong>Codex</strong> <span className="mono">test/flaky</span>
                <span className="tag" data-on="true">
                  needs you
                </span>
              </div>
              <div className={`${styles.cardBody} mono`}>“migration 0042” · 3m</div>
              <div className={styles.cardActions}>
                <span className={styles.miniBtn} data-on="true">
                  Review grant
                </span>
                <span className={styles.miniBtn}>Deny</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className={styles.col}>
        <h3>Every key</h3>
        <p>
          Log into Vercel, AWS, Google Cloud, Supabase, GitHub and your servers once, in one place. Agents
          never hold the keys. They borrow access, for an hour, with your fingerprint for anything live. Every
          borrow is written down.
        </p>
        <div className={styles.art} aria-hidden="true">
          <table className={`${styles.targets} mono`}>
            <thead>
              <tr>
                <th>Target</th>
                <th>Policy</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Vercel · prod</td>
                <td>Ask · MFA</td>
                <td>
                  <span className="sq" data-on="true" /> open · 58m left
                </td>
              </tr>
              <tr>
                <td>Supabase · prod db</td>
                <td>Ask · MFA</td>
                <td>
                  <span className="sq" data-hollow="true" /> locked
                </td>
              </tr>
              <tr>
                <td>GitHub</td>
                <td>Always allow</td>
                <td>
                  <span className={`sq ${styles.sqTx}`} /> persistent
                </td>
              </tr>
              <tr>
                <td>AWS · staging</td>
                <td>Ask each time</td>
                <td>
                  <span className="sq" /> expired
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
);
