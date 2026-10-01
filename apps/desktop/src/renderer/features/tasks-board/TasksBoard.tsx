import {
  AGENT_LABEL,
  copy,
  fill,
  navLanes,
  type ProjectId,
  type ReadModel,
  type SessionId,
} from '@styx/core';
import { AgentDot, Button, Select, Textarea } from '@styx/ui';
import { useId, useState, type KeyboardEvent } from 'react';
import { ChatPane } from '../chat/ChatPane';
import { SPAWN_AGENTS } from '../modals/modals';
import { useSpawnForm } from '../modals/use-spawn-form';
import { useModel, useNow, useUi } from '../../state/hooks';
import s from './TasksBoard.module.css';

const selectModel = (m: ReadModel) => m;
const AGENT_OPTIONS = SPAWN_AGENTS.map((a) => ({ value: a, label: copy.agentProducts[a] }));

export interface TasksBoardProps {
  projectId: ProjectId;
  /** The lane in the chat: it is already beside the board, so it gets no tile. */
  activeSessionId: SessionId | null;
}

/**
 * The Tasks instrument (#138): the project's other running lanes side by side, each a small chat (the pop-out's
 * compact pane) under its task and whose turn it is, so a question is answered where it stands. "Open in chat"
 * brings a lane into the chat. The last tile starts another lane alongside without leaving the one in focus.
 */
export function TasksBoard({ projectId, activeSessionId }: TasksBoardProps) {
  const now = useNow();
  const model = useModel(selectModel);
  const openSession = useUi((u) => u.openSession);
  const lanes = navLanes(model, projectId, now).filter(
    (l) => l.status !== 'landed' && l.status !== 'finished' && l.sessionId !== activeSessionId,
  );
  const anyLane = activeSessionId !== null || lanes.length > 0;

  return (
    <div
      className={s['board']}
      role="region"
      aria-label={copy.chat.tasks.label}
      data-tasks-board="true"
      data-count={lanes.length + 1}
      data-odd={(lanes.length + 1) % 2 === 1 ? 'true' : undefined}
    >
      {lanes.map((lane) => {
        const branch = model.worktrees.byId[lane.worktreeId]?.branch ?? '';
        const titleId = `tasks-tile-${lane.sessionId}`;
        return (
          <section
            key={lane.sessionId}
            className={s['tile']}
            aria-labelledby={titleId}
            data-tasks-tile={lane.sessionId}
            data-you={lane.status === 'your-turn' ? 'true' : undefined}
          >
            <header className={s['head']}>
              <div className={s['who']}>
                <AgentDot agent={lane.agent} />
                <span>{AGENT_LABEL[lane.agent]}</span>
                <span className={s['branch']}>{branch}</span>
                <button
                  type="button"
                  className={s['open']}
                  aria-label={fill(copy.chat.tasks.openInChatNamed, { task: lane.task })}
                  onClick={() => openSession(projectId, lane.sessionId)}
                  data-tasks-open={lane.sessionId}
                >
                  {copy.chat.tasks.openInChat}
                </button>
              </div>
              <h3 id={titleId} className={s['task']} title={lane.task}>
                {lane.task}
              </h3>
              <span className={s['status']} data-tone={lane.status === 'your-turn' ? 'yours' : undefined}>
                {lane.statusLabel}
              </span>
            </header>
            <div className={s['chat']}>
              <ChatPane projectId={projectId} sessionId={lane.sessionId} tile />
            </div>
          </section>
        );
      })}
      <Alongside projectId={projectId} first={!anyLane} />
    </div>
  );
}

/** The last tile: a task box, the agent, Start. The new lane joins the board; the chat keeps its lane. */
function Alongside({ projectId, first }: { projectId: ProjectId; first: boolean }) {
  const platform = useUi((u) => u.platform);
  const { form, setForm, pickAgent, valid, busy, spawn } = useSpawnForm(projectId);
  const [text, setText] = useState('');
  const ids = { text: useId(), agent: useId() };
  const ready = valid && text.trim() !== '';
  const start = async () => {
    if (!ready) return;
    const id = await spawn(text.trim());
    if (id !== null) {
      setText('');
      setForm((f) => ({ ...f, firstMessage: '' }));
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      void start();
    }
  };
  const t = copy.chat.tasks.alongside;
  return (
    <section
      className={[s['tile'], s['add']].join(' ')}
      aria-labelledby={`${ids.text}-title`}
      data-tasks-add="true"
    >
      <div className={s['addIn']}>
        <h3 id={`${ids.text}-title`} className={s['addTitle']}>
          {first ? t.first : t.title}
        </h3>
        <p className={s['addBody']}>{first ? t.firstBody : t.body}</p>
        <label htmlFor={ids.text} className="visually-hidden">
          {t.label}
        </label>
        <Textarea
          id={ids.text}
          className={s['addText']}
          minHeight={64}
          placeholder={t.placeholder}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          data-tasks-add-text="true"
        />
        <div className={s['addRow']}>
          <label htmlFor={ids.agent} className="visually-hidden">
            {t.agent}
          </label>
          <AgentDot agent={form.agent} />
          <Select
            id={ids.agent}
            value={form.agent}
            onChange={(e) => {
              const picked = SPAWN_AGENTS.find((a) => a === e.currentTarget.value);
              if (picked !== undefined) pickAgent(picked);
            }}
            options={AGENT_OPTIONS}
            data-tasks-add-agent="true"
          />
          <Button
            variant="accent"
            disabled={!ready || busy}
            onClick={() => void start()}
            className={s['addStart'] ?? ''}
            data-tasks-add-start="true"
          >
            {t.start}
          </Button>
        </div>
      </div>
    </section>
  );
}
