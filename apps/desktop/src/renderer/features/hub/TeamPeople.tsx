import { copy, fill, type HubMember } from '@styx/core';
import { Button } from '@styx/ui';
import { useCallback, useEffect, useState } from 'react';
import { command } from '../../state/commands';
import s from './HubLaneControl.module.css';
import l from './Lean.module.css';

const t = copy.hub.lean;

/**
 * The people on the team, in Settings (the web app is off, so this is where a team admin invites someone or takes
 * them off the team). Everyone sees who is on it; only an admin sees Invite and Remove.
 */
export function TeamPeople() {
  const [members, setMembers] = useState<HubMember[] | null>(null);
  const [admin, setAdmin] = useState(false);
  const [team, setTeam] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await command('hub.teamMembers', {});
    if (r.ok) {
      setMembers(r.value.members);
      setAdmin(r.value.admin);
      setTeam(r.value.team);
    } else setError(r.error.message);
  }, []);
  useEffect(() => {
    let live = true;
    void command('hub.teamMembers', {}).then((r) => {
      if (!live) return;
      if (r.ok) {
        setMembers(r.value.members);
        setAdmin(r.value.admin);
        setTeam(r.value.team);
      } else setError(r.error.message);
    });
    return () => {
      live = false;
    };
  }, []);

  if (members === null) return error === null ? null : <p className={s['error']}>{error}</p>;
  return (
    <section aria-labelledby="hub-people" data-hub-people="true" className={s['create']}>
      <h3 id="hub-people" className="t-label-strong">
        {fill(t.members, { team })}
      </h3>
      <ul className={s['list']}>
        {members.map((m) => {
          const who = m.name ?? m.email ?? '';
          return (
            <li key={m.userId} className={l['row']} style={{ padding: '6px 10px' }}>
              <span>
                <b>{who}</b> {m.email !== null && m.name !== null ? m.email : ''}
                {m.role === 'admin' ? ' · admin' : ''}
              </span>
              {admin ? (
                <button
                  type="button"
                  className={s['link']}
                  aria-label={`${t.remove}: ${who}`}
                  onClick={() => {
                    if (!window.confirm(fill(t.removeConfirm, { name: who, team }))) return;
                    void command('hub.removeMember', { userId: m.userId }).then((r) => {
                      if (r.ok) void load();
                      else setError(r.error.message);
                    });
                  }}
                >
                  {t.remove}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {admin ? (
        <form
          className={s['create']}
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            void command('hub.invite', {
              email: email.trim(),
              ...(name.trim() === '' ? {} : { name: name.trim() }),
            }).then((r) => {
              if (r.ok) setLink(r.value.link);
              else setError(r.error.message);
            });
          }}
          data-hub-invite="true"
        >
          <span className="t-label-strong">{t.invite}</span>
          <p className={s['hint']}>{t.inviteLead}</p>
          <label className={l['label']} htmlFor="hub-invite-email">
            {t.inviteEmail}
          </label>
          <input
            id="hub-invite-email"
            className={s['input']}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
          />
          <label className={l['label']} htmlFor="hub-invite-name">
            {t.inviteName}
          </label>
          <input
            id="hub-invite-name"
            className={s['input']}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Button type="submit" variant="accent" disabled={email.trim() === ''}>
            {t.makeInvite}
          </Button>
          {link !== null ? (
            <div className={l['linkbox']}>
              <input
                className={l['url']}
                readOnly
                value={link}
                aria-label={t.inviteLink}
                onFocus={(e) => e.currentTarget.select()}
                data-hub-invite-link="true"
              />
              <Button onClick={() => void navigator.clipboard?.writeText(link)}>{t.copyLink}</Button>
            </div>
          ) : null}
        </form>
      ) : null}
      {error !== null ? (
        <p className={s['error']} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
