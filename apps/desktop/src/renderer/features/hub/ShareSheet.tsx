import { copy, fill, hubSpaceOf, type ProjectId, type ReadModel, type SessionId } from '@styx/core';
import { Button, ChipGroup, Sheet } from '@styx/ui';
import { useEffect, useState } from 'react';
import { onEvent } from '../../state/bridge';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import s from './ShareSheet.module.css';

type Props = { id: string; sessionId: SessionId; projectId: ProjectId };

type Access = 'team' | 'anyone';
type Expiry = '1d' | '7d' | '30d' | 'never';
type Pick = { id: string; items: { name: string; files: number; bytes: number }[] };

const selectHub = (m: ReadModel) => m.hub;

/** 1.2 MB, 38 MB, 812 KB: what the sheet says about sizes. */
export const sizeLabel = (bytes: number): string =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * The Share sheet (ADR-0032 phase 2, mockup styx-next-hub-sharing.html frame A): choose files or a folder through
 * the OS picker, who can open it and for how long, then Share and copy link. The renderer only ever holds the pick's
 * id; main reads and uploads the files.
 */
export function ShareSheet({ id, sessionId, projectId }: Props) {
  const popOverlay = useUi((u) => u.popOverlay);
  const hub = useModel(selectHub);
  const space = hubSpaceOf(hub, projectId);
  const [pick, setPick] = useState<Pick | null>(null);
  const [access, setAccess] = useState<Access>('team');
  const [expiresIn, setExpiresIn] = useState<Expiry>('7d');
  const [review, setReview] = useState(true);
  const [title, setTitle] = useState('');
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'done'>('idle');
  const [progress, setProgress] = useState({ sent: 0, total: 0 });
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => popOverlay(id);

  useEffect(
    () =>
      onEvent('hub.share.progress', (p) => {
        if (pick !== null && p.pickId === pick.id) setProgress({ sent: p.sent, total: p.total });
      }),
    [pick],
  );

  const choose = async (mode: 'files' | 'folder') => {
    setError(null);
    const r = await command('hub.pickShare', { sessionId, mode });
    if (!r.ok) setError(r.error.message);
    else if (r.value.pick !== null) setPick(r.value.pick);
  };

  const share = async () => {
    if (pick === null) return;
    setPhase('uploading');
    setError(null);
    const r = await command('hub.share', {
      sessionId,
      pickId: pick.id,
      access,
      expiresIn,
      review,
      ...(title.trim() === '' ? {} : { title: title.trim() }),
    });
    if (!r.ok) {
      setPhase('idle');
      setError(r.error.message);
      return;
    }
    setUrl(r.value.url);
    setPhase('done');
    void navigator.clipboard?.writeText(r.value.url).catch(() => undefined);
  };

  const total = pick?.items.reduce((n, i) => n + i.bytes, 0) ?? 0;
  const pct = progress.total === 0 ? 0 : Math.round((progress.sent / progress.total) * 100);

  return (
    <Sheet
      title={copy.hub.share.title}
      onClose={close}
      escapeEnabled={phase !== 'uploading'}
      footer={
        phase === 'done' ? (
          <div className={s['acts']}>
            <Button onClick={close}>{copy.hub.share.close}</Button>
          </div>
        ) : (
          <div className={s['acts']}>
            <Button variant="ghost" onClick={close} disabled={phase === 'uploading'}>
              {copy.hub.cancel}
            </Button>
            <Button
              variant="accent"
              onClick={() => void share()}
              disabled={pick === null || phase === 'uploading' || space === null}
              data-hub-share-go="true"
            >
              {copy.hub.share.go}
            </Button>
          </div>
        )
      }
    >
      <div className={s['body']} data-hub-share-sheet={phase}>
        {phase === 'done' && url !== null ? (
          <div className={s['done']} role="status">
            <b>{copy.hub.share.done}</b>
            <div className={s['link']}>
              <span className={s['url']}>{url}</span>
              <Button onClick={() => void navigator.clipboard?.writeText(url).catch(() => undefined)}>
                {copy.hub.share.copy}
              </Button>
            </div>
            <Button variant="ghost" onClick={() => void command('hub.openWeb', {})}>
              {copy.hub.share.openWeb}
            </Button>
          </div>
        ) : (
          <>
            <div className={s['pickers']}>
              <p className={s['lead']}>{copy.hub.share.lead}</p>
              <div className={s['row']}>
                <Button
                  onClick={() => void choose('files')}
                  disabled={phase === 'uploading'}
                  data-hub-share-files="true"
                >
                  {copy.hub.share.chooseFiles}
                </Button>
                <Button
                  onClick={() => void choose('folder')}
                  disabled={phase === 'uploading'}
                  data-hub-share-folder="true"
                >
                  {copy.hub.share.chooseFolder}
                </Button>
              </div>
            </div>
            {pick === null ? (
              <p className={s['lead']}>{copy.hub.share.nothing}</p>
            ) : (
              <ul className={s['picked']} aria-label={copy.hub.share.title}>
                {pick.items.map((item) => (
                  <li key={item.name}>
                    <b>{item.name}</b>
                    <span>
                      {item.files > 1 ? `${fill(copy.hub.share.files, { n: String(item.files) })} · ` : ''}
                      {sizeLabel(item.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <label className={s['label']} htmlFor="hub-share-title">
              {copy.hub.share.nameLabel}
            </label>
            <input
              id="hub-share-title"
              className={s['input']}
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.currentTarget.value)}
            />
            <div className={s['q']}>
              <span className={s['label']}>{copy.hub.share.who}</span>
              <ChipGroup
                layout="inline"
                size="env"
                aria-label={copy.hub.share.who}
                value={access}
                onChange={(v) => setAccess(v as Access)}
                options={[
                  { value: 'team', label: fill(copy.hub.share.team, { space: space?.name ?? '' }) },
                  { value: 'anyone', label: copy.hub.share.anyone },
                ]}
              />
            </div>
            <div className={s['q']}>
              <span className={s['label']}>{copy.hub.share.expires}</span>
              <ChipGroup
                aria-label={copy.hub.share.expires}
                value={expiresIn}
                onChange={(v) => setExpiresIn(v as Expiry)}
                options={(['1d', '7d', '30d', 'never'] as const).map((v) => ({
                  value: v,
                  label: copy.hub.share.expiry[v],
                }))}
              />
            </div>
            <div className={s['q']}>
              <span className={s['label']}>{copy.hub.share.ask}</span>
              <ChipGroup
                layout="inline"
                size="env"
                aria-label={copy.hub.share.ask}
                value={review ? 'review' : 'none'}
                onChange={(v) => setReview(v === 'review')}
                options={[
                  { value: 'review', label: copy.hub.share.review },
                  { value: 'none', label: copy.hub.share.noReview },
                ]}
              />
            </div>
            {phase === 'uploading' ? (
              <div className={s['progress']} role="status" aria-live="polite">
                <span>
                  {fill(copy.hub.share.uploading, {
                    sent: sizeLabel(progress.sent),
                    total: sizeLabel(progress.total || total),
                  })}
                </span>
                <div
                  className={s['bar']}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                  aria-label={copy.hub.share.go}
                >
                  <i style={{ width: `${pct}%` }} />
                </div>
              </div>
            ) : null}
          </>
        )}
        {error !== null ? (
          <p className={s['error']} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
