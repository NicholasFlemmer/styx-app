import { accountLabel, copy, fill, formatAge, type ReadModel } from '@styx/core';
import { Button, Checkbox, LabelValueRow, StatusDot } from '@styx/ui';
import { command } from '../../state/commands';
import { useModel, useNow, useUi } from '../../state/hooks';
import s from './AccountPane.module.css';

const selectAccount = (m: ReadModel) => m.account;
const selectUsageReports = (m: ReadModel) => m.settings.app.usageReports;

/**
 * The usage-reports switch (discrepancy row 114). It sits with the account because that is what counts are tied
 * to, it says what is and is not sent in one line, and it is one click to turn off.
 */
function UsageRow({ signedIn }: { signedIn: boolean }) {
  const enabled = useModel(selectUsageReports);
  return (
    <div className={s['usage']} data-usage-reports={enabled ? 'on' : 'off'}>
      <Checkbox
        checked={enabled}
        onChange={(checked) => void command('settings.set', { patch: { usageReports: checked } })}
        label={copy.account.usage.label}
        data-usage-toggle="true"
      />
      <span className={['t-meta', s['usageHint']].join(' ')}>
        {signedIn ? copy.account.usage.hint : copy.account.usage.signedOut}
      </span>
    </div>
  );
}

const run = (name: 'account.signOut' | 'account.refresh') => void command(name, {});

/**
 * Settings › App › Account (ADR-0026). Signing in is optional — the pane says what an account is for and then
 * gets out of the way. The device flow happens here rather than in a modal: it is one line of state, and a
 * modal would trap focus while the person is in their browser anyway.
 */
export function AccountPane() {
  const account = useModel(selectAccount);
  const now = useNow(30_000);
  const pushOverlay = useUi((u) => u.pushOverlay);

  if (account.kind === 'signed-in') {
    const a = account.account;
    return (
      <div className={s['pane']} data-account="signed-in">
        <LabelValueRow
          label={copy.account.title}
          control={<span className={s['value']}>{accountLabel(a)}</span>}
        />
        <LabelValueRow label="Email" control={<span className={s['value']}>{a.email}</span>} />
        <LabelValueRow
          label={copy.account.plan}
          control={
            <span className={s['value']}>
              {a.planUntil === null
                ? copy.account.plans[a.plan]
                : `${copy.account.plans[a.plan]} · ${fill(copy.account.planUntil, { when: formatAge(a.planUntil, now) })}`}
            </span>
          }
        />
        <div className={s['meta']}>
          <span className="t-meta">
            {fill(copy.account.signedInVia, { provider: copy.account.providers[a.provider] })} ·{' '}
            {fill(copy.account.signedInSince, { when: formatAge(account.signedInAt, now) })}
          </span>
        </div>
        {account.staleSince !== null && (
          <div className={s['row']} data-account-stale="true">
            <StatusDot tone="line" size={7} />
            <span className="t-meta">
              {fill(copy.account.stale, { when: formatAge(account.staleSince, now) })}
            </span>
          </div>
        )}
        <p className={s['note']}>{copy.account.usedFor}</p>
        <UsageRow signedIn />
        <div className={s['actions']}>
          <Button onClick={() => run('account.refresh')}>{copy.account.refresh}</Button>
          <Button variant="ghost" onClick={() => run('account.signOut')} data-account-signout="true">
            {copy.account.signOut}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={s['pane']} data-account="signed-out">
      {/* The pane is for managing an account; getting one is the dialog's job (discrepancy row 113). */}
      <p className={s['lead']}>{copy.account.paneSignedOut}</p>
      <div className={s['actions']}>
        <Button
          onClick={() => pushOverlay({ kind: 'modal', modal: 'sign-in', reason: 'plain' })}
          data-account-signin="true"
        >
          {copy.account.signIn}
        </Button>
      </div>
      <UsageRow signedIn={false} />
    </div>
  );
}
