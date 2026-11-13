import {
  copy,
  fill,
  hubSpaceOf,
  isLaneShared,
  type ProjectId,
  type ReadModel,
  type SessionId,
} from '@styx/core';
import { Button } from '@styx/ui';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './HubLaneControl.module.css';

const selectHub = (m: ReadModel) => m.hub;

type Props = { projectId: ProjectId; projectName: string; sessionId: SessionId };

/**
 * The team hub in the lane header (ADR-0032; owner: connecting projects must not be hidden in Settings). Connected:
 * the lane's share switch, Only you / Shared with {space}. Not connected: Connect to team hub, which opens a small
 * panel that signs in (showing the code to type), or picks a space, or makes one, in the place the person already is.
 */
export function HubLaneControl({ projectId, projectName, sessionId }: Props) {
  const hub = useModel(selectHub);
  const setScreen = useUi((u) => u.setScreen);
  const setSettingsSection = useUi((u) => u.setSettingsSection);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(projectName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const space = hubSpaceOf(hub, projectId);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current !== null && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);


  if (space !== null) {
    const shared = isLaneShared(hub, sessionId);
    return (
      <>
        <button
          type="button"
          className={s['tool']}
          title={copy.hub.share.lead}
          onClick={() => pushOverlay({ kind: 'sheet', sheet: 'hub-share', sessionId, projectId })}
          data-hub-share-open="true"
        >
          {copy.hub.share.button}
        </button>
        <button
          type="button"
          className={s['tool']}
          aria-pressed={shared}
          data-inv={shared ? 'true' : undefined}
          title={fill(shared ? copy.hub.lane.unshareTitle : copy.hub.lane.shareTitle, { space: space.name })}
          onClick={() => void command('hub.shareLane', { sessionId, shared: !shared })}
          data-hub-share={shared ? 'shared' : 'only-you'}
        >
          {shared ? fill(copy.hub.lane.shared, { space: space.name }) : copy.hub.lane.onlyYou}
        </button>
      </>
    );
  }

  const run = async (go: () => Promise<{ ok: boolean; error?: { message: string } }>) => {
    setBusy(true);
    setError(null);
    const r = await go();
    setBusy(false);
    if (!r.ok) setError(r.error?.message ?? copy.hub.failed);
  };

  const link = (spaceId: string) => run(() => command('hub.linkProject', { projectId, spaceId }));
  const create = () =>
    run(async () => {
      const made = await command('hub.createSpace', { name: name.trim() });
      if (!made.ok) return made;
      return command('hub.linkProject', { projectId, spaceId: made.value.spaceId });
    });

  const c = hub.connection;
  const writable = c.kind === 'signed-in' ? c.spaces.filter((sp) => sp.role !== 'viewer') : [];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className={s['wrap']} ref={wrap} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={s['tool']}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={copy.hub.connect.title}
        onClick={() => setOpen((o) => !o)}
        data-hub-connect="true"
      >
        {copy.hub.connect.button}
      </button>
      {open ? (
        <div
          className={s['panel']}
          role="dialog"
          aria-label={copy.hub.connect.button}
          data-hub-connect-panel={c.kind}
        >
          {c.kind === 'signed-out' ? (
            <>
              <p className={s['lead']}>{copy.hub.connect.signInLead}</p>
              {c.error !== null ? (
                <p className={s['error']} role="alert">
                  {c.error}
                </p>
              ) : null}
              <div className={s['acts']}>
                <Button
                  variant="accent"
                  onClick={() => void command('hub.signIn', {})}
                  data-hub-connect-signin="true"
                >
                  {copy.hub.signIn}
                </Button>
              </div>
            </>
          ) : c.kind === 'signing-in' ? (
            <>
              <span className="t-meta">{copy.hub.codeLabel}</span>
              <span className={s['code']} data-hub-code="true">
                {c.userCode}
              </span>
              <div className={s['acts']}>
                <Button onClick={() => void command('hub.openVerification', {})}>
                  {copy.hub.openBrowser}
                </Button>
                <Button variant="ghost" onClick={() => void command('hub.cancelSignIn', {})}>
                  {copy.hub.cancel}
                </Button>
              </div>
            </>
          ) : (
            <>
              <b className={s['head']}>{fill(copy.hub.connect.pick, { project: projectName })}</b>
              {writable.length > 0 ? (
                <div
                  className={s['list']}
                  role="group"
                  aria-label={fill(copy.hub.connect.pick, { project: projectName })}
                >
                  {writable.map((sp) => (
                    <button
                      key={sp.id}
                      type="button"
                      className={s['item']}
                      disabled={busy}
                      onClick={() => void link(sp.id)}
                      data-hub-connect-space={sp.id}
                    >
                      {sp.name}
                    </button>
                  ))}
                </div>
              ) : (
                <p className={s['lead']}>{copy.hub.connect.noSpaces}</p>
              )}
              <form
                className={s['create']}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim() !== '') void create();
                }}
              >
                <label className="t-meta" htmlFor="hub-new-space">
                  {copy.hub.connect.newSpaceLabel}
                </label>
                <input
                  id="hub-new-space"
                  className={s['input']}
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.currentTarget.value)}
                />
                <Button type="submit" disabled={busy || name.trim() === ''} data-hub-connect-create="true">
                  {copy.hub.connect.create}
                </Button>
              </form>
              {error !== null ? (
                <p className={s['error']} role="alert">
                  {error}
                </p>
              ) : null}
              <p className={s['hint']}>{copy.hub.connect.pickHint}</p>
            </>
          )}
          <button
            type="button"
            className={s['link']}
            onClick={() => {
              setOpen(false);
              setSettingsSection('app:hub');
              setScreen('settings');
            }}
          >
            {copy.hub.connect.settings}
          </button>
        </div>
      ) : null}
    </div>
  );
}
