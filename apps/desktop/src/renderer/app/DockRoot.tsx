import { boardColumns, copy, fill, type BoardCard } from '@styx/core';
import { StatusDot, Tag } from '@styx/ui';
import { useEffect, useMemo } from 'react';
import { chromePlatform } from '../state/bridge';
import { command } from '../state/commands';
import { useModel, useNow } from '../state/hooks';
import { useReadModel } from '../state/read-model';
import { connectSync } from '../state/sync';
import { useThemeController, usePlatformAttr } from './AppRoot';
import s from './DockRoot.module.css';

/**
 * The agent dock: a narrow always-on-top window listing every agent that needs you, across every project.
 *
 * It carries no state of its own. The read model was already global — one snapshot fanned to every window — and
 * `boardColumns` was already cross-project, so this is the Agents board's own data in one column. Clicking a
 * card brings the main window forward on that session rather than opening a chat here: the dock is for noticing,
 * not for working.
 */
export function DockRoot() {
  useThemeController();
  usePlatformAttr();
  useEffect(() => connectSync(), []);
  // Lifts the main window's 1100×680 `#root` minimum for a 300px-wide dock.
  useEffect(() => {
    document.documentElement.dataset['window'] = 'dock';
  }, []);

  const connection = useReadModel((st) => st.connection);
  const now = useNow();
  const model = useModel((m) => m);
  const columns = useMemo(() => boardColumns(model, now), [model, now]);
  const needs = columns.find((c) => c.key === 'needs-you')?.items ?? [];
  const working = columns.find((c) => c.key === 'working')?.items ?? [];

  const focus = (card: BoardCard) => {
    void command('window.focusSession', { sessionId: card.sessionId });
  };

  return (
    <div className={s['root']} data-dock="true" data-connection={connection}>
      <div className={s['titlebar']} data-chrome={chromePlatform()}>
        <span className="t-label">{copy.chat.agentDock.title}</span>
        <span className={s['count']}>{needs.length > 0 ? needs.length : ''}</span>
      </div>
      <div className={s['list']}>
        {needs.length === 0 && working.length === 0 && (
          <div className={s['empty']}>
            <span className="t-label">{copy.chat.agentDock.empty}</span>
          </div>
        )}
        {needs.map((card: BoardCard) => (
          <DockCard key={card.sessionId} card={card} needs onClick={() => focus(card)} />
        ))}
        {working.length > 0 && (
          <div className={s['section']}>
            <span className="t-label">{copy.chat.agentDock.working}</span>
          </div>
        )}
        {working.map((card: BoardCard) => (
          <DockCard key={card.sessionId} card={card} onClick={() => focus(card)} />
        ))}
      </div>
    </div>
  );
}

function DockCard({ card, needs, onClick }: { card: BoardCard; needs?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={s['card']}
      data-on={needs === true ? 'true' : undefined}
      aria-label={fill(copy.chat.agentDock.focus, { agent: card.agent, project: card.project })}
      onClick={onClick}
      data-dock-card={card.sessionId}
    >
      <span className={s['head']}>
        <StatusDot tone={card.needs ? 'accent' : card.paused ? 'hollow' : 'text'} size={7} />
        <span className={s['agent']}>{card.agent}</span>
        <Tag tone="neutral">{card.project}</Tag>
      </span>
      <span className={s['branch']}>{card.branch}</span>
      {card.note !== null && card.note !== '' && <span className={s['note']}>{card.note}</span>}
    </button>
  );
}
