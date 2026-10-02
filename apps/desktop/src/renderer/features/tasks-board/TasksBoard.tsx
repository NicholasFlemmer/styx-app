import { AGENT_LABEL, copy, navLanes, type ProjectId, type ReadModel, type SessionId } from '@styx/core';
import { AgentDot, Button, Select, Textarea } from '@styx/ui';
import { useId, useState, type KeyboardEvent } from 'react';
import { SPAWN_AGENTS } from '../modals/modals';
import { useSpawnForm } from '../modals/use-spawn-form';
import { useModel, useNow, useUi } from '../../state/hooks';
import { taskCard } from './task-card';
import s from './TasksBoard.module.css';

const selectModel = (m: ReadModel) => m;
const AGENT_OPTIONS = SPAWN_AGENTS.map((a) => ({ value: a, label: copy.agentProducts[a] }));

export interface TasksBoardProps {
  projectId: ProjectId;
  /** The lane in the chat: its card is marked. */
  activeSessionId: SessionId | null;
}

/**
 * The Tasks instrument (#138): every running task in the project as a card of its live status: its task, whose
 * turn, the latest steps as they happen, its status line and what it holds. A card is a button: it opens the task's
 * lane in the chat (the one already there is marked). The last card starts another task alongside.
 */
export function TasksBoard({ projectId, activeSessionId }: TasksBoardProps) {
  const model = useModel(selectModel);
  const openSession = useUi((u) => u.openSession);
  const now = useNow();
  const lanes = navLanes(model, projectId, now).filter(
    (l) => l.status !== 'landed' && l.status !== 'finished',
  );

  return (
    <div
      className={s['board']}
      role="region"
      aria-label={copy.chat.tasks.label}
      data-tasks-board="true"
      data-count={lanes.length + 1}
    >
      {lanes.map((lane) => {
        const here = lane.sessionId === activeSessionId;
        const card = taskCard(model, lane.sessionId);
        const branch = model.worktrees.byId[lane.worktreeId]?.branch ?? '';
        return (
          <button
            key={lane.sessionId}
            type="button"
            className={s['card']}
            aria-current={here ? 'true' : undefined}
            data-here={here ? 'true' : undefined}
            data-you={lane.status === 'your-turn' ? 'true' : undefined}
            onClick={() => openSession(projectId, lane.sessionId)}
            data-tasks-card={lane.sessionId}
          >
            <span className={s['who']}>
              <AgentDot agent={lane.agent} />
              <span>{AGENT_LABEL[lane.agent]}</span>
              <span className={s['branch']}>{branch}</span>
              {here ? <span className={s['here']}>{copy.chat.tasks.inChat}</span> : null}
            </span>
            <span className={s['task']}>{lane.task}</span>
            <span className={s['status']} data-tone={lane.status === 'your-turn' ? 'yours' : undefined}>
              {lane.statusLabel}
            </span>
            {card.steps.length > 0 ? (
              <span className={s['steps']} data-tasks-steps="true">
                {card.steps.map((step) => (
                  <span key={step.key} className={s['step']} data-status={step.status}>
                    {step.label}
                  </span>
                ))}
              </span>
            ) : null}
            {card.note !== null && card.note !== lane.task ? (
              <span className={s['note']}>{card.note}</span>
            ) : null}
            {card.summary !== '' ? <span className={s['summary']}>{card.summary}</span> : null}
          </button>
        );
      })}
      <Alongside projectId={projectId} first={lanes.length === 0} />
    </div>
  );
}

/** The last card: a task box, the agent, Start. The new task joins the board; the chat keeps its lane. */
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
          minHeight={56}
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
