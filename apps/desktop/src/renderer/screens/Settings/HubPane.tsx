import { copy, fill, formatAge, type ReadModel } from '@styx/core';
import { Button, LabelValueRow, StatusDot } from '@styx/ui';
import { command } from '../../state/commands';
import { TeamPeople } from '../../features/hub/TeamPeople';
import { useModel, useNow } from '../../state/hooks';
import s from './AccountPane.module.css';

const selectHub = (m: ReadModel) => m.hub;

/**
 * Settings › App › Team hub (ADR-0032). The pilot seat's view of home base: sign in with the work Google account,
 * see the team, and link each project to the space its lanes are shared with. Linking shares nothing by itself;
 * a lane is shared from its own header.
 */
export function HubPane() {
  const hub = useModel(selectHub);
  const now = useNow(30_000);
  const c = hub.connection;

  if (c.kind === 'signing-in')
    return (
      <div className={s['pane']} data-hub="signing-in">
        <div className={s['code']}>
          <span className="t-meta">{copy.hub.codeLabel}</span>
          <span className={s['userCode']} data-hub-code="true">
            {c.userCode}
          </span>
        </div>
        <div className={s['actions']}>
          <Button onClick={() => void command('hub.openVerification', {})}>{copy.hub.openBrowser}</Button>
          <Button variant="ghost" onClick={() => void command('hub.cancelSignIn', {})}>
            {copy.hub.cancel}
          </Button>
        </div>
      </div>
    );

  if (c.kind === 'signed-out')
    return (
      <div className={s['pane']} data-hub="signed-out">
        <p className={s['lead']}>{copy.hub.lead}</p>
        {c.error !== null && (
          <p className={s['note']} role="alert" data-hub-error="true">
            {c.error}
          </p>
        )}
        <div className={s['actions']}>
          <Button variant="accent" onClick={() => void command('hub.signIn', {})} data-hub-signin="true">
            {copy.hub.signIn}
          </Button>
        </div>
      </div>
    );

  return (
    <div className={s['pane']} data-hub="signed-in">
      <LabelValueRow
        label={copy.hub.title}
        control={
          <span className={s['value']}>
            {fill(copy.hub.signedInAs, { who: c.account.name ?? c.account.email })}
          </span>
        }
      />
      <LabelValueRow
        label={copy.hub.team}
        control={
          <span className={s['value']}>{c.teams.map((t) => `${t.name} · ${t.domain}`).join(', ')}</span>
        }
      />
      {c.staleSince !== null && (
        <div className={s['row']} data-hub-stale="true">
          <StatusDot tone="line" size={7} />
          <span className="t-meta">{fill(copy.hub.stale, { when: formatAge(c.staleSince, now) })}</span>
        </div>
      )}
      <TeamPeople />
      <div className={s['actions']}>
        <Button onClick={() => void command('hub.refresh', {})}>{copy.hub.refresh}</Button>
        <Button variant="ghost" onClick={() => void command('hub.signOut', {})} data-hub-signout="true">
          {copy.hub.signOut}
        </Button>
      </div>
    </div>
  );
}
