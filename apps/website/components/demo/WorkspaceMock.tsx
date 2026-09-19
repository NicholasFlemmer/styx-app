import { reached, waitingOnYou, type DemoStep } from '@/lib/demo-script';
import type { Chrome } from './DemoContext';
import styles from './WorkspaceMock.module.css';

export const WORKSPACE_FULL = { w: 956, h: 560 } as const; // rail 56 + files 200 + editor 340 + chat 360
export const WORKSPACE_COMPACT = { w: 360, h: 560 } as const; // chat pane only

type Props = { step: DemoStep; compact: boolean; chrome: Chrome };

/** The Styx workspace mid-grant. Pure: what shows depends only on the step. */
export const WorkspaceMock = ({ step, compact, chrome }: Props) => {
  const sheetOpen = step === 'sheet' || step === 'mfa';
  const needsYou = waitingOnYou(step);
  const granted = reached(step, 'granted');

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
          <span className={styles.projectChip}>
            acme-shop <span className={styles.caret}>▾</span>
          </span>
          <span className={`${styles.branch} mono`}>test/flaky</span>
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
            <div className={styles.files}>
              <div className={styles.paneLabel}>Files</div>
              <ul className={`${styles.tree} mono`}>
                <li className={styles.dir}>supabase/</li>
                <li className={styles.dir} data-depth="1">
                  migrations/
                </li>
                <li data-depth="2" data-inv="true">
                  0042_status.sql <span className="sq" data-on="true" />
                </li>
                <li data-depth="2">0041_carts.sql</li>
                <li className={styles.dir}>src/</li>
                <li data-depth="1">
                  orders.ts <span className="sq" data-on="true" />
                </li>
                <li data-depth="1">checkout.ts</li>
                <li className={styles.dir}>tests/</li>
                <li data-depth="1">
                  orders.test.ts <span className="sq" data-on="true" />
                </li>
              </ul>
              <div className={styles.paneLabel}>Changes · 3</div>
              <ul className={`${styles.changes} mono`}>
                <li>
                  <span className={styles.status}>A</span>0042_status.sql
                </li>
                <li>
                  <span className={styles.status}>M</span>orders.ts
                </li>
                <li>
                  <span className={styles.status}>M</span>orders.test.ts
                </li>
              </ul>
              <div className={styles.filesFoot}>
                <span className={styles.ghostBtn}>Open in VS Code</span>
              </div>
            </div>
            <div className={styles.center}>
              <div className={styles.tabs}>
                <span className={styles.tab} data-inv="true">
                  0042_status.sql
                </span>
                <span className={styles.tab}>orders.ts</span>
                <span className={styles.tab}>
                  orders.test.ts <span className="tag">codex</span>
                </span>
              </div>
              <ol className={`${styles.editor} mono`}>
                <li>
                  <span className={styles.ln}>1</span>-- 0042: order status
                </li>
                <li data-add="true">
                  <span className={styles.ln}>2</span>alter table orders
                  <span className={styles.hunkMeta}>codex · 1m</span>
                </li>
                <li data-add="true">
                  <span className={styles.ln}>3</span>{'  '}add column status text
                </li>
                <li data-add="true">
                  <span className={styles.ln}>4</span>{'  '}not null default &apos;open&apos;;
                </li>
                <li>
                  <span className={styles.ln}>5</span>
                </li>
                <li data-add="true">
                  <span className={styles.ln}>6</span>create index orders_status_idx
                </li>
                <li data-add="true">
                  <span className={styles.ln}>7</span>{'  '}on orders (status);
                </li>
                <li>
                  <span className={styles.ln}>8</span>
                </li>
                <li>
                  <span className={styles.ln}>9</span>-- rollback: drop column status
                </li>
              </ol>
              <div className={styles.hunkbar}>
                <span className={`label ${styles.hunkLabel}`}>2 hunks · Codex</span>
                <span className={styles.hunkActions}>
                  <span className={styles.miniBtn} data-inv="true">
                    Accept all
                  </span>
                  <span className={styles.miniBtn}>Review</span>
                  <span className={styles.miniBtn}>Reject</span>
                </span>
              </div>
              <div className={`${styles.terminal} mono`}>
                <div className={styles.paneLabel}>Terminal · test/flaky</div>
                <div className={styles.termLines}>
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
                    <div>
                      Applying 0042_status.sql…
                      <span className={styles.cursor} />
                    </div>
                  )}
                  {reached(step, 'logged') && <div className={styles.termOk}>✓ pushed 1 migration (2.1s)</div>}
                  {reached(step, 'logged') && (
                    <div>
                      $<span className={styles.cursor} />
                    </div>
                  )}
                </div>
              </div>
              <div className={styles.statusbar}>
                <span>test/flaky</span>
                <span>{granted ? 'Supabase prod · open 60m' : 'Supabase · locked'}</span>
                <span className={styles.statusRight}>LF · SQL</span>
              </div>
            </div>
          </>
        )}
        <div className={styles.chat}>
          <div className={styles.tabs}>
            <span className={styles.tab} data-inv="true">
              Codex <span className={`${styles.tabBranch} mono`}>test/flaky</span>
              <span className="sq" data-on={needsYou ? 'true' : undefined} data-hollow={needsYou ? undefined : 'true'} />
            </span>
            <span className={styles.tab}>
              Claude <span className={`${styles.tabBranch} mono`}>fix/checkout</span>
            </span>
          </div>
          <div className={styles.transcript}>
            <div className={styles.msgUser}>Run migration 0042 on prod. The suite depends on the new orders.status column.</div>
            <div className={styles.msgAgent}>
              <span className={styles.msgWho}>Codex</span>
              Reading supabase/migrations/0042_orders_status.sql. It adds orders.status with a default and an index. Pushing
              to the linked project.
            </div>
            <div className={`${styles.toolLine} mono`}>$ supabase db push --linked</div>
            {reached(step, 'ask') && (
              <div className={styles.request} data-on={needsYou ? 'true' : undefined}>
                <div className={styles.requestHead}>
                  <span className="sq" data-on={needsYou ? 'true' : undefined} />
                  <span className="label">Access request · Supabase / prod db</span>
                </div>
                <p>Scope: write. No grant on file for this target.</p>
                {needsYou && (
                  <div className={styles.requestActions}>
                    <span className={styles.miniBtn} data-on="true">
                      Review request
                    </span>
                    <span className={styles.miniBtn}>Deny</span>
                  </div>
                )}
              </div>
            )}
            {granted && (
              <div className={`${styles.grantLine} mono`}>
                <span className="sq" data-on="true" />
                grant: supabase prod db · write · expires in 1h
              </div>
            )}
            {reached(step, 'logged') && (
              <div className={styles.msgAgent}>
                <span className={styles.msgWho}>Codex</span>
                Migration applied. 42 tests pass.
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
                  <span className="tag" data-on="true">
                    prod
                  </span>
                  <span className="tag">postgres</span>
                </div>
                <blockquote className={`${styles.quote} mono`}>
                  “to run migration 0042 — read schema, then apply. Test suite depends on the new orders.status column.”
                </blockquote>
                <div className="label">Scope</div>
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
                <div className="label">Duration</div>
                <div className={styles.segments}>
                  <span>once</span>
                  <span data-inv="true">1h</span>
                  <span>session</span>
                  <span>always</span>
                </div>
                <p className={styles.note}>
                  {chrome === 'win' ? 'Prod write requires Windows Hello.' : 'Prod write requires Touch ID.'} Token is scoped to
                  this session and revoked on expiry or when the session ends. Logged to audit.
                </p>
              </div>
              <div className={styles.sheetFoot}>
                <span className={styles.footBtn}>Deny</span>
                <span className={styles.footBtn} data-on="true">
                  {step === 'mfa' ? (
                    <>
                      <span className={styles.blink} />
                      {chrome === 'win' ? 'Windows Hello…' : 'Touch ID…'}
                    </>
                  ) : chrome === 'win' ? (
                    'Grant 1h · Windows Hello'
                  ) : (
                    'Grant 1h · Touch ID'
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
          <div className={`${styles.toastMeta} mono`}>audit · granted write to Codex · 1h · grant sheet</div>
        </div>
      )}
    </div>
  );
};
