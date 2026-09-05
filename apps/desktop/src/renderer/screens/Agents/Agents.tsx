import { boardColumns, copy, type BoardCard, type BoardColumn, type ReadModel, type SessionId } from '@styx/core';
import { Button, Card, Numeral, Tag } from '@styx/ui';
import { useCallback, useEffect, useRef } from 'react';
import { approveGrantAsRequested, boardBindings } from '../../keys/bindings';
import { keys } from '../../keys';
import { command } from '../../state/commands';
import { useModel, useNow, useUi } from '../../state/hooks';
import { useReadModel } from '../../state/read-model';
import { useUiStore } from '../../state/ui-store';
import s from './Agents.module.css';

const toneOf = (card: BoardCard): 'needs' | 'working' | 'done' =>
  card.needs ? 'needs' : card.state === 'done' ? 'done' : 'working';

/** Primary CTA (spec §4.3): Open · Review grant · Review plan · Archive. */
const runCta = (card: BoardCard): void => {
  const ui = useUiStore.getState();
  if (card.state === 'done') {
    void command('session.archive', { sessionId: card.sessionId });
    return;
  }
  ui.openSession(card.projectId, card.sessionId);
  if (card.needs && card.askKind === 'grant' && card.askId !== null) {
    ui.pushOverlay({ kind: 'sheet', sheet: 'grant', sessionId: card.sessionId, askId: card.askId });
  }
};

/**
 * Mod+⏎ on a focused needs-you card (spec §6 "board card"): a grant ask is approved as requested (its scope,
 * 1h — the same path as Review grant → Grant), a plan ask runs the card's CTA (Review plan).
 */
const runApprove = (card: BoardCard): void => {
  if (!card.needs) return;
  if (card.askKind === 'grant' && card.askId !== null) {
    const ask = useReadModel.getState().model.pendingAsks.byId[card.askId];
    const grant = ask?.grantId == null ? undefined : useReadModel.getState().model.grants.byId[ask.grantId];
    if (grant !== undefined) {
      approveGrantAsRequested(grant);
      return;
    }
  }
  runCta(card);
};

/** Deny on a needs-you card: `grant.deny` for the head grant ask, `ask.respond` reject for plan asks. */
const runDeny = (card: BoardCard): void => {
  if (card.askId === null) return;
  const ask = useReadModel.getState().model.pendingAsks.byId[card.askId];
  if (ask === undefined) return;
  if (ask.kind === 'grant' && ask.grantId !== null) {
    void command('grant.deny', { grantId: ask.grantId });
    return;
  }
  if (ask.kind === 'plan') {
    void command('ask.respond', {
      askId: ask.id,
      resolution: { kind: 'plan', outcome: 'rejected', note: null },
    });
  }
};

function BoardCardView({ card, onFocusCard }: { card: BoardCard; onFocusCard: (id: SessionId) => void }) {
  // Needs-you cards are focusable (tabIndex -1: reached from their buttons / the Approve chord) and carry the
  // `board` key scope so Mod+⏎ / Mod+⌫ resolve to this card (spec §6).
  const focusable = card.needs
    ? {
        role: 'group',
        tabIndex: -1,
        'data-keyscope': 'board',
        'aria-label': `${card.agent} · ${card.project} · ${card.branch}`,
        onFocus: () => onFocusCard(card.sessionId),
      }
    : {};
  return (
    <Card
      agent={card.agent}
      age={card.age}
      project={card.project}
      branch={card.branch}
      note={card.note}
      tone={toneOf(card)}
      data-session={card.sessionId}
      {...focusable}
      actions={
        <>
          <Button onClick={() => runCta(card)}>{card.cta}</Button>
          {card.needs ? (
            <Button variant="ghost" onClick={() => runDeny(card)}>
              {copy.board.actions.deny}
            </Button>
          ) : null}
        </>
      }
    />
  );
}

function Column({
  column,
  onSpawn,
  onFocusCard,
}: {
  column: BoardColumn;
  onSpawn: () => void;
  onFocusCard: (id: SessionId) => void;
}) {
  return (
    <section className={s['column']} aria-label={column.label} data-column={column.key}>
      <div className={s['head']}>
        <Tag size="md" tone="strong" on={column.hot} className={s['label']}>
          {column.label}
        </Tag>
        <Numeral size="M" value={column.items.length} aria-label={`${column.count} ${column.label}`} />
      </div>
      {column.items.map((card) => (
        <BoardCardView key={card.sessionId} card={card} onFocusCard={onFocusCard} />
      ))}
      {column.empty ? <div className={s['empty']}>{column.emptyText}</div> : null}
      {column.spawn ? (
        <Button variant="dashed" className={s['spawn']} onClick={onSpawn}>
          {copy.board.actions.spawn}
        </Button>
      ) : null}
    </section>
  );
}

/** Agents board (spec §4.3): Needs you | Working (incl. idle) | Done, across all projects. */
export function Agents() {
  const now = useNow();
  const select = useCallback((model: ReadModel) => boardColumns(model, now), [now]);
  const columns = useModel(select);
  const projectId = useUi((u) => u.projectId);

  const onSpawn = useCallback(() => {
    const ui = useUiStore.getState();
    if (projectId !== null) ui.pushOverlay({ kind: 'modal', modal: 'spawn', projectId });
    else ui.openPalette('actions');
  }, [projectId]);

  /** The card that last received focus (focus events bubble from its buttons too). */
  const focused = useRef<SessionId | null>(null);
  const onFocusCard = useCallback((id: SessionId) => {
    focused.current = id;
  }, []);
  const focusedCard = useCallback((): BoardCard | null => {
    const id = focused.current;
    if (id === null) return null;
    const cols = boardColumns(useReadModel.getState().model, Date.now());
    return cols.flatMap((c) => c.items).find((c) => c.sessionId === id && c.needs) ?? null;
  }, []);
  useEffect(
    () =>
      keys.registerAll(
        boardBindings({
          approve: () => {
            const card = focusedCard();
            if (card === null) return false;
            runApprove(card);
            return true;
          },
          deny: () => {
            const card = focusedCard();
            if (card === null) return false;
            runDeny(card);
            return true;
          },
        }),
      ),
    [focusedCard],
  );

  return (
    <div className={s['board']} data-board="agents">
      {columns.map((column) => (
        <Column key={column.key} column={column} onSpawn={onSpawn} onFocusCard={onFocusCard} />
      ))}
    </div>
  );
}
