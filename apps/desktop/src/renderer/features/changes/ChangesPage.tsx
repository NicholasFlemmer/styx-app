import { copy, laneChanges, type ProjectId, type ReadModel, type SessionId } from '@styx/core';
import { Button, EmptyState, Markdown } from '@styx/ui';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { DiffBlock } from '../diff';
import { patchFiles } from '../../screens/Diff/CheckpointDiff';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import { LandButton } from '../workspace/LandButton';
import s from './ChangesPage.module.css';

export interface ChangesPageProps {
  projectId: ProjectId;
  sessionId: SessionId | null;
}

/** One turn on the page: its request and change; Show fetches its patch; Undo asks first. */
function TurnSection({
  checkpointId,
  title,
  change,
  undone,
  busy,
}: {
  checkpointId: string;
  title: string;
  change: string;
  undone: boolean;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [patch, setPatch] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const undoButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open || patch !== null) return;
    let live = true;
    void command('checkpoint.diff', { checkpointId }).then((r) => {
      if (live) setPatch(r.ok ? r.value.patch : '');
    });
    return () => {
      live = false;
    };
  }, [open, patch, checkpointId]);
  useEffect(() => {
    if (asking) confirmButton.current?.focus();
  }, [asking]);
  const cancel = () => {
    setAsking(false);
    requestAnimationFrame(() => undoButton.current?.focus());
  };
  const onAskKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  const files = patch === null ? [] : patchFiles(patch);
  return (
    <section className={s['turn']} data-changes-turn={checkpointId} data-undone={undone ? 'true' : undefined}>
      <div className={s['turnHead']}>
        <b className={s['turnTitle']}>{title}</b>
        <span className={s['turnChange']}>{change}</span>
        <span className={s['turnActs']}>
          <Button size="compact" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? copy.chat.changes.hide : copy.chat.changes.show}
          </Button>
          {undone ? (
            <span className={s['undone']}>{copy.chat.turn.undone}</span>
          ) : (
            <Button
              ref={undoButton}
              size="compact"
              disabled={busy}
              title={busy ? copy.chat.turn.busy : undefined}
              onClick={() => setAsking(true)}
            >
              {copy.chat.turn.undo}
            </Button>
          )}
        </span>
      </div>
      {asking && !undone ? (
        <div className={s['ask']} role="group" aria-label={copy.chat.turn.undo} onKeyDown={onAskKeyDown}>
          <span>{copy.chat.turn.undoAsk}</span>
          <Button
            ref={confirmButton}
            size="compact"
            variant="primary"
            onClick={() => {
              setAsking(false);
              void command('checkpoint.revert', { checkpointId });
            }}
          >
            {copy.chat.turn.undoConfirm}
          </Button>
          <Button size="compact" onClick={cancel}>
            {copy.chat.turn.undoCancel}
          </Button>
        </div>
      ) : null}
      {open ? (
        <div className={s['diff']}>
          {patch === null ? <p className={s['muted']}>{copy.chat.changes.loading}</p> : null}
          {files.map((f) => (
            <div key={f.path} data-patch-file={f.path}>
              <div className={s['file']}>
                <span>{f.path}</span>
                <span>
                  +{f.added} −{f.removed}
                </span>
              </div>
              <DiffBlock rows={f.rows} gutter="spaced" />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The Changes instrument (ADR-0027 §2 / §3): the lane as a page you sign off. Where it stands, what it was for and
 * whether another lane touches the same files; what the agent says it did; every turn with its own diff, each
 * undoable on its own. One decision bar: Land, Ask for changes (back to the composer), Review hunk by hunk (the
 * key-driven review screen, unchanged).
 */
export function ChangesPage({ projectId, sessionId }: ChangesPageProps) {
  const lane = useModel(
    useCallback((m: ReadModel) => (sessionId === null ? null : laneChanges(m, sessionId)), [sessionId]),
  );
  const busy = useModel(
    useCallback(
      (m: ReadModel) => {
        const st = sessionId === null ? undefined : m.sessions.byId[sessionId]?.state;
        return st === 'working' || st === 'needs-you';
      },
      [sessionId],
    ),
  );
  const setScreen = useUi((u) => u.setScreen);
  if (lane === null) {
    return (
      <div className={s['wrap']} data-changes-page="none">
        <EmptyState headline={copy.chat.changes.noLane} />
      </div>
    );
  }
  const empty = lane.turns.length === 0 && !lane.loose;
  return (
    <div className={s['wrap']} data-changes-page={lane.sessionId}>
      <article className={s['page']}>
        <div className={s['ready']}>
          <span className={s['state']} data-state={lane.state}>
            <i aria-hidden="true" />
            {lane.stateLabel}
          </span>
          <span>{lane.byLine}</span>
          <span>{lane.overlap}</span>
        </div>
        <h2 className={s['headline']}>{lane.headline}</h2>
        {lane.lastReply !== null ? (
          <div className={s['sum']}>
            <Markdown text={lane.lastReply} onLink={(url) => void command('link.open', { url })} />
          </div>
        ) : null}
        {empty ? (
          <div className={s['empty']}>
            <b>{copy.chat.changes.emptyHeadline}</b>
            <p>{copy.chat.changes.emptyBody}</p>
          </div>
        ) : null}
        {lane.turns.length > 0 ? <h3 className={s['sub']}>{copy.chat.changes.whatItDid}</h3> : null}
        {lane.turns.map((t) => (
          <TurnSection
            key={t.checkpointId}
            checkpointId={t.checkpointId}
            title={t.title}
            change={t.change}
            undone={t.undone}
            busy={busy}
          />
        ))}
        {lane.loose ? (
          <section className={s['turn']} data-changes-loose="true">
            <div className={s['turnHead']}>
              <b className={s['turnTitle']}>{copy.chat.changes.loose}</b>
              <span className={s['turnActs']}>
                <Button size="compact" onClick={() => setScreen('diff')}>
                  {copy.chat.changes.review}
                </Button>
              </span>
            </div>
            <p className={s['looseBody']}>{copy.chat.changes.looseBody}</p>
          </section>
        ) : null}
      </article>
      <div className={s['decide']} data-changes-decide="true">
        <LandButton projectId={projectId} placement="page" />
        <Button
          onClick={() =>
            document.querySelector<HTMLTextAreaElement>('[data-keyscope="composer"] textarea')?.focus()
          }
        >
          {copy.chat.changes.ask}
        </Button>
        <Button variant="ghost" onClick={() => setScreen('diff')}>
          {copy.chat.changes.review}
        </Button>
      </div>
    </div>
  );
}
