import { AGENT_LABEL, copy, fill, type ReadModel, type SessionId } from '@styx/core';
import { Button, Checkbox, Textarea } from '@styx/ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { command } from '../../state/commands';
import { useModel } from '../../state/hooks';
import s from './PreviewFix.module.css';

export interface Pick {
  label: string;
  detail: string;
  image: string | null;
}

/**
 * Select to fix in the running app (#140): `start` hands the page to main's pick (hover outlines, click one element,
 * drag an area, Escape cancels) and resolves with what was picked; `stop` cancels it.
 */
export function usePreviewPick() {
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      void command('preview.pick', { mode: 'off' });
    },
    [],
  );
  const start = useCallback(async () => {
    setPick(null);
    setPicking(true);
    const r = await command('preview.pick', { mode: 'pick' });
    if (!alive.current) return;
    setPicking(false);
    if (r.ok && r.value.pick !== null) setPick(r.value.pick);
  }, []);
  const stop = useCallback(() => {
    void command('preview.pick', { mode: 'off' });
    setPicking(false);
  }, []);
  return { picking, pick, start, stop, clear: () => setPick(null) };
}

const selectModel = (m: ReadModel) => m;

/** What was picked, a box for what is wrong, and Send: to this lane's agent, or its design task's. */
export function FixStrip({
  pick,
  sessionId,
  onDone,
}: {
  pick: Pick;
  sessionId: SessionId | null;
  onDone: () => void;
}) {
  const model = useModel(selectModel);
  const session = sessionId === null ? null : (model.sessions.byId[sessionId] ?? null);
  const hasDesign = session?.designSessionId !== undefined;
  const [text, setText] = useState('');
  const [toDesign, setToDesign] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const p = copy.chat.pick;
  const target =
    toDesign && session?.designSessionId !== undefined
      ? (model.sessions.byId[session.designSessionId] ?? session)
      : session;
  const send = async () => {
    if (session === null || text.trim() === '' || busy) return;
    setBusy(true);
    await command('session.sendMessage', {
      sessionId: session.id,
      body: text.trim(),
      attachments:
        pick.image === null
          ? []
          : [{ kind: 'image', name: 'selection.png', mediaType: 'image/png', data: pick.image }],
      pointer: { source: 'preview', label: pick.label, detail: pick.detail, toDesign },
    });
    setBusy(false);
    onDone();
  };
  return (
    <div className={s['strip']} data-preview-fix="true">
      <div className={s['head']}>
        <b>{pick.label.startsWith('Area ') ? p.titleArea : p.title}</b>
        <span className={s['chip']} title={pick.label}>
          {pick.label}
        </span>
      </div>
      <label htmlFor={id} className="visually-hidden">
        {p.label}
      </label>
      <Textarea
        id={id}
        autoFocus
        minHeight={48}
        className={s['box'] ?? ''}
        placeholder={p.placeholder}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void send();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onDone();
          }
        }}
        data-preview-fix-text="true"
      />
      <div className={s['row']}>
        {hasDesign ? <Checkbox checked={toDesign} onChange={setToDesign} label={p.toDesign} /> : null}
        <span className={s['spacer']} />
        <Button size="compact" variant="ghost" onClick={onDone}>
          {p.cancel}
        </Button>
        <Button
          size="compact"
          variant="accent"
          disabled={session === null || text.trim() === '' || busy}
          onClick={() => void send()}
          data-preview-fix-send="true"
        >
          {fill(p.send, { agent: target === null ? '' : AGENT_LABEL[target.agent] })}
        </Button>
      </div>
    </div>
  );
}
