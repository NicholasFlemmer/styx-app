import { reached, waitingOnYou, type DemoStep } from '@/lib/demo-script';
import type { Chrome } from './DemoContext';
import styles from './WorkspaceMock.module.css';

/** Rail 56 + project nav 200 + the lane's instrument 424 + chat 360, at the app's real type sizes. */
export const WORKSPACE_FULL = { w: 1040, h: 600 } as const;
export const WORKSPACE_COMPACT = { w: 360, h: 600 } as const; // chat pane only

type Props = { step: DemoStep; compact: boolean; chrome: Chrome };

const tabs = ['Tasks', 'Design', 'Preview', 'Changes', 'Code', 'Terminal'] as const;

/**
 * The tab in front at each step, as you would move through the app: the board shows the task asking, Changes shows
 * what it wants to apply while you decide, Terminal shows it run, and Changes again once it is ready to land.
 */
const MODE: Readonly<Record<DemoStep, 'Tasks' | 'Changes' | 'Terminal'>> = {
  command: 'Tasks',
  ask: 'Tasks',
  sheet: 'Changes',
  mfa: 'Changes',
  granted: 'Terminal',
  logged: 'Changes',
};

/**
 * The Styx window mid-grant, drawn as the app is laid out since 0.4 (ADR-0027, #138–#140): lanes in the project nav,
 * the lane's tabs, its Changes page, the chat with the request inline, and the access sheet over the chat. Pure: what
 * shows depends only on the step.
 */
export const WorkspaceMock = ({ step, compact, chrome }: Props) => {
  const sheetOpen = step === 'sheet' || step === 'mfa';
  const needsYou = waitingOnYou(step);
  const granted = reached(step, 'granted');
  const logged = reached(step, 'logged');
  const mfa = chrome === 'win' ? 'Windows Hello' : 'Touch ID';
  const mode = MODE[step];

  return (
    <div className={styles.app} data-compact={compact ? 'true' : undefined} data-chrome={chrome}>
      {!compact && (
        <div className={styles.titlebar}>
          {chrome === 'mac' && (
            <span className={styles.lights}>
              <span />
              <span />
              <span />
            </span>
          )}
          <span className={styles.wordmark}>STYX</span>
          <span className={styles.paletteField}>
            <span>Switch, spawn, deploy, grant…</span>
            <span className="mono">{chrome === 'win' ? 'Ctrl K' : '⌘K'}</span>
          </span>
          <span className={styles.counter}>
            <span className="sq" data-on={needsYou ? 'true' : undefined} />
            {needsYou ? '01' : '00'} needs you
          </span>
          <span className={styles.counter}>
            <span className="sq" data-hollow="true" />
            {granted ? '01' : '02'} locked
          </span>
          {chrome === 'win' && (
            <span className={styles.caption}>
              <span>─</span>
              <span>☐</span>
              <span>✕</span>
            </span>
          )}
        </div>
      )}
      <div className={styles.body}>
        {!compact && (
          <>
            <div className={styles.rail}>
              <span className={styles.tile} data-on="true">
                AS
              </span>
              <span className={styles.tile}>
                BL
                <span className="sq" data-on="true" />
              </span>
              <span className={styles.tile}>IN</span>
              <span className={styles.tile}>CX</span>
              <span className={styles.tile}>SA</span>
              <span className={styles.tileAdd}>+</span>
            </div>

            <div className={styles.nav}>
              <div className={styles.project}>
                <strong>acme-shop</strong>
                <span className="mono">test/flaky</span>
              </div>
              <div className={styles.navHead}>
                <span>Work</span>
                <span>3 lanes</span>
              </div>
              <div className={styles.lane} data-inv="true">
                <span className={styles.agentSq} data-agent="codex" />
                <span className={styles.laneText}>
                  <span className={styles.laneTitle}>Fix the flaky order test and make sure the schema…</span>
                  {needsYou ? (
                    <span className={styles.yourTurn}>Your turn</span>
                  ) : (
                    <span className={styles.laneMeta}>{logged ? 'Done, now' : 'Working, now'}</span>
                  )}
                </span>
              </div>
              <div className={styles.lane}>
                <span className={styles.agentSq} data-agent="claude" />
                <span className={styles.laneText}>
                  <span className={styles.laneTitle}>Add input validation to checkout and cover it…</span>
                  <span className={styles.laneMeta}>Working, 14m</span>
                </span>
              </div>
              <div className={styles.lane}>
                <span className={styles.agentSq} data-agent="gemini" />
                <span className={styles.laneText}>
                  <span className={styles.laneTitle}>Design the checkout: one Pay button</span>
                  <span className={styles.laneMeta}>Design · 3 screens</span>
                </span>
              </div>
              <div className={styles.newTask}>+ New task</div>
            </div>

            <div className={styles.center}>
              <div className={styles.modes}>
                {tabs.map((t) => (
                  <span key={t} className={styles.mode} data-inv={t === mode ? 'true' : undefined}>
                    {t}
                  </span>
                ))}
              </div>
              {mode === 'Tasks' && (
                <div className={styles.board}>
                  <div className={styles.card} data-on={needsYou ? 'true' : undefined}>
                    <div className={styles.cardTop}>
                      <span className={styles.agentSq} data-agent="codex" />
                      <span>Codex</span>
                      <span className="mono">test/flaky</span>
                      <span className={styles.kind}>Build</span>
                    </div>
                    <div className={styles.cardTitle}>
                      Fix the flaky order test and make sure the schema matches prod.
                    </div>
                    {needsYou ? (
                      <>
                        <span className={styles.yourTurn}>Your turn</span>
                        <div className={styles.cardLine}>Requesting Supabase prod · read + write</div>
                      </>
                    ) : (
                      <div className={styles.cardMeta}>Working, now</div>
                    )}
                    <div className={styles.cardFoot}>1 file changed</div>
                  </div>
                  <div className={styles.card}>
                    <div className={styles.cardTop}>
                      <span className={styles.agentSq} data-agent="claude" />
                      <span>Claude</span>
                      <span className="mono">fix/checkout</span>
                      <span className={styles.kind}>Build</span>
                    </div>
                    <div className={styles.cardTitle}>
                      Add input validation to checkout and cover it with tests.
                    </div>
                    <div className={styles.cardMeta}>Working, 14m</div>
                    <div className={styles.cardLine}>Added validation, 42 tests pass.</div>
                    <div className={styles.cardFoot}>3 files changed</div>
                  </div>
                  <div className={styles.card}>
                    <div className={styles.cardTop}>
                      <span className={styles.agentSq} data-agent="gemini" />
                      <span>Gemini</span>
                      <span className="mono">design/pay</span>
                      <span className={styles.kind}>Design</span>
                    </div>
                    <div className={styles.cardTitle}>Design the checkout: one Pay button</div>
                    <div className={styles.cardMeta}>Working, 3m</div>
                    <div className={styles.cardFoot}>3 screens</div>
                  </div>
                  <div className={styles.cardAdd}>
                    <div className={styles.cardTitle}>Start another lane alongside</div>
                    <div className={styles.cardMeta}>Its own branch, so it never steps on the others.</div>
                  </div>
                </div>
              )}
              {mode === 'Changes' && (
                <>
                  <div className={styles.page}>
                    <div className={styles.paper}>
                      <div className={styles.paperMeta}>
                        <span className={styles.state}>
                          <span className={styles.stateSq} data-on={needsYou ? 'true' : undefined} />
                          {needsYou ? 'Waiting on you' : logged ? 'Ready to land' : 'Working'}
                        </span>
                        <span>Codex, 1 turn</span>
                      </div>
                      <div className={styles.paperTitle}>
                        Fix the flaky order test and make sure the schema matches prod.
                      </div>
                      <p className={styles.paperBody}>
                        {logged
                          ? 'Migration 0042 is applied to prod and the order test passes, 42 of 42.'
                          : 'The test fails because migration 0042 was never applied to prod. It adds orders.status with a default and an index.'}
                      </p>
                      <div className={styles.file}>
                        <div className={`${styles.fileHead} mono`}>
                          <span>supabase/migrations/0042_status.sql</span>
                          <span className={styles.plus}>+5</span>
                        </div>
                        <ol className={`${styles.diff} mono`}>
                          <li>-- 0042: order status</li>
                          <li data-add="true">alter table orders</li>
                          <li data-add="true">{'  '}add column status text</li>
                          <li data-add="true">{'  '}not null default &apos;open&apos;;</li>
                          <li data-add="true">create index orders_status_idx</li>
                          <li data-add="true">{'  '}on orders (status);</li>
                        </ol>
                      </div>
                    </div>
                  </div>
                  <div className={styles.actions}>
                    <span className={styles.miniBtn} data-on={logged ? 'true' : undefined}>
                      ↓ Land
                    </span>
                    <span className={styles.miniBtn}>Ask for changes</span>
                  </div>
                </>
              )}
              <div className={`${styles.terminal} mono`} data-full={mode === 'Terminal' ? 'true' : undefined}>
                <div className={styles.termLabel}>Terminal, test/flaky</div>
                <div className={styles.termLines}>
                  {mode === 'Terminal' && (
                    <>
                      <div>$ npx vitest run orders</div>
                      <div className={styles.termMuted}>✗ orders.test.ts › status defaults to open</div>
                      <div className={styles.termMuted}>{'  '}column &quot;status&quot; does not exist</div>
                    </>
                  )}
                  <div>$ supabase db push --linked</div>
                  <div className={styles.termMuted}>styx: prod db needs a grant (write)</div>
                  {needsYou && (
                    <div className={styles.termMuted}>
                      ⏸ waiting on you
                      <span className={styles.cursor} />
                    </div>
                  )}
                  {granted && <div className={styles.termOk}>✓ grant supabase/prod-db · write · 1h</div>}
                  {step === 'granted' && (
                    <>
                      <div className={styles.termMuted}>Connecting to remote database…</div>
                      <div className={styles.termMuted}>Applying migration 0042_status.sql…</div>
                      <div>
                        alter table orders add column status text
                        <span className={styles.cursor} />
                      </div>
                    </>
                  )}
                  {logged && <div className={styles.termOk}>✓ pushed 1 migration (2.1s)</div>}
                </div>
              </div>
              <div className={styles.statusbar}>
                <span>test/flaky</span>
                <span>{granted ? 'Supabase prod · open 60m' : 'Supabase prod · locked'}</span>
              </div>
            </div>
          </>
        )}

        <div className={styles.chat}>
          <div className={styles.laneHead}>
            <div className={styles.laneHeadTop}>
              <span className={styles.agentSq} data-agent="codex" />
              <span>Codex</span>
              <span className="mono">test/flaky</span>
              {needsYou && <span className={styles.waiting}>waiting on you</span>}
            </div>
            <div className={styles.laneHeadTitle}>
              Fix the flaky order test and make sure the schema matches prod.
            </div>
            <div className={styles.laneHeadFoot}>
              <span>1 file changed</span>
              <span className={styles.miniBtn}>↓ Land</span>
            </div>
          </div>
          <div className={styles.transcript}>
            <div className={styles.msgUser}>
              Fix the flaky order test and make sure the schema matches prod.
            </div>
            <div className={styles.msgAgent}>
              The test fails because migration 0042 was never applied to prod. I need to read the prod schema
              and apply it.
            </div>
            {reached(step, 'ask') && (
              <div className={styles.request} data-on={needsYou ? 'true' : undefined}>
                <div className={styles.requestHead}>Access request · Supabase prod</div>
                <div className={styles.requestBody}>
                  <p>Scope: read schema, write. No grant on file for this target.</p>
                  {needsYou && (
                    <div className={styles.requestActions}>
                      <span className={styles.miniBtn} data-inv="true">
                        Review request
                      </span>
                      <span className={styles.miniBtn}>Deny</span>
                    </div>
                  )}
                  {granted && (
                    <div className={`${styles.grantLine} mono`}>
                      <span className="sq" data-on="true" />
                      Granted · write · 1h · {mfa}
                    </div>
                  )}
                </div>
              </div>
            )}
            {logged && (
              <div className={styles.msgAgent}>
                Migration applied to prod. The order test passes, 42 of 42.
              </div>
            )}
          </div>
          <div className={styles.composer}>
            <span>Message Codex…</span>
            <span className="mono">⏎ send</span>
          </div>

          {sheetOpen && (
            <div className={styles.sheet}>
              <div className={styles.sheetHead}>
                <span>Access request</span>
                <span>Codex · test/flaky</span>
              </div>
              <div className={styles.sheetBody}>
                <div className={styles.sheetTitle}>
                  Supabase <span className={styles.slash}>/</span> prod db
                </div>
                <div className={styles.tags}>
                  <span className={styles.tag} data-inv="true">
                    prod
                  </span>
                  <span className={styles.tag}>Postgres</span>
                </div>
                <blockquote className={`${styles.quote} mono`}>
                  “to run migration 0042 — read schema, then apply. Test suite depends on the new
                  orders.status column.”
                </blockquote>
                <div className={styles.sheetLabel}>Scope</div>
                <ul className={styles.scopes}>
                  <li>
                    Read schema <span className={styles.check} data-on="true" />
                  </li>
                  <li>
                    Write <span className={styles.check} data-on="true" />
                  </li>
                  <li className={styles.dimRow}>
                    Delete / drop <span className={styles.check} />
                  </li>
                </ul>
                <div className={styles.sheetLabel}>Duration</div>
                <div className={styles.segments}>
                  <span>once</span>
                  <span data-on="true">1h</span>
                  <span>session</span>
                  <span>always</span>
                </div>
                <p className={styles.note}>
                  Prod write requires {mfa}. Token is scoped to this session and revoked on expiry or when the
                  session ends. Logged to audit.
                </p>
              </div>
              <div className={styles.sheetFoot}>
                <span className={styles.footBtn}>Deny</span>
                <span className={styles.footBtn} data-on="true">
                  {step === 'mfa' ? (
                    <>
                      <span className={styles.blink} />
                      {mfa}…
                    </>
                  ) : (
                    `Grant 1h · ${mfa}`
                  )}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
      {step === 'logged' && (
        <div className={styles.toast}>
          <div>Granted Codex write on Supabase / prod db for 1h</div>
          <div className={`${styles.toastMeta} mono`}>audit · granted write to Codex · 1h · {mfa}</div>
        </div>
      )}
    </div>
  );
};
