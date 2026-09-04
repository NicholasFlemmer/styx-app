import { boardColumns, copy, type BoardCard, type BoardColumn, type ReadModel } from '@styx/core';
import { Button, Card, Numeral, Tag } from '@styx/ui';
import { useCallback } from 'react';
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

function BoardCardView({ card }: { card: BoardCard }) {
  return (
    <Card
      agent={card.agent}
      age={card.age}
      project={card.project}
      branch={card.branch}
      note={card.note}
      tone={toneOf(card)}
      data-session={card.sessionId}
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

function Column({ column, onSpawn }: { column: BoardColumn; onSpawn: () => void }) {
  return (
    <section className={s['column']} aria-label={column.label} data-column={column.key}>
      <div className={s['head']}>
        <Tag size="md" tone="strong" on={column.hot} className={s['label']}>
          {column.label}
        </Tag>
        <Numeral size="M" value={column.items.length} aria-label={`${column.count} ${column.label}`} />
      </div>
      {column.items.map((card) => (
        <BoardCardView key={card.sessionId} card={card} />
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

  return (
    <div className={s['board']} data-board="agents">
      {columns.map((column) => (
        <Column key={column.key} column={column} onSpawn={onSpawn} />
      ))}
    </div>
  );
}
