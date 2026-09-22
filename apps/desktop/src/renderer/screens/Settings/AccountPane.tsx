import {
  ACCOUNT_PROVIDERS,
  accountLabel,
  copy,
  fill,
  formatAge,
  type AccountProvider,
  type ReadModel,
} from '@styx/core';
import { Button, Label, LabelValueRow, StatusDot } from '@styx/ui';
import { command } from '../../state/commands';
import { useModel, useNow } from '../../state/hooks';
import s from './AccountPane.module.css';

const selectAccount = (m: ReadModel) => m.account;

const run = (
  name: 'account.cancelSignIn' | 'account.signOut' | 'account.refresh' | 'account.openVerification',
) => void command(name, {});

/**
 * Settings › App › Account (ADR-0026). Signing in is optional — the pane says what an account is for and then
 * gets out of the way. The device flow happens here rather than in a modal: it is one line of state, and a
 * modal would trap focus while the person is in their browser anyway.
 */
export function AccountPane() {
  const account = useModel(selectAccount);
  const now = useNow(30_000);

  if (account.kind === 'signing-in') {
    return (
      <div className={s['pane']} data-account="signing-in">
        <p className={s['lead']}>{copy.account.signedOutLead}</p>
        <div className={s['code']} data-account-code="true">
          <Label>{copy.account.codeLabel}</Label>
          <span className={s['userCode']}>{account.userCode}</span>
        </div>
        <div className={s['row']}>
          <StatusDot tone="accent" size={7} className={s['blink']} />
          <span className="t-meta">{copy.account.waiting}</span>
        </div>
        <div className={s['actions']}>
          <Button onClick={() => run('account.openVerification')}>{copy.account.openAgain}</Button>
          <Button variant="ghost" onClick={() => run('account.cancelSignIn')} data-account-cancel="true">
            {copy.account.cancel}
          </Button>
        </div>
      </div>
    );
  }

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
      {/* The pane header already says Account; this only has to say what one is for. */}
      <p className={s['lead']}>{copy.account.signedOutLead}</p>
      <div className={s['actions']}>
        {ACCOUNT_PROVIDERS.map((provider: AccountProvider) => (
          <Button
            key={provider}
            onClick={() => void command('account.signIn', { provider })}
            data-account-signin={provider}
          >
            {fill(copy.account.signInWith, { provider: copy.account.providers[provider] })}
          </Button>
        ))}
      </div>
      {account.error !== null && (
        <div className={s['row']} data-account-error="true">
          <StatusDot tone="accent" size={7} />
          <span className="t-meta">{account.error}</span>
        </div>
      )}
    </div>
  );
}
