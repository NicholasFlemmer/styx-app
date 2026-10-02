import { copy, fill, type Agent, type DesignList, type SessionId } from '@styx/core';
import { AgentDot, Button, Checkbox, Modal, Select, Textarea } from '@styx/ui';
import { useId, useState } from 'react';
import { command } from '../../state/commands';
import { SPAWN_AGENTS } from '../modals/modals';
import s from './DesignCanvas.module.css';

export interface HandoverDialogProps {
  designSessionId: SessionId;
  agent: Agent;
  design: DesignList;
  onClose: () => void;
  /** Resolves with the task that builds it: a new build task, or the design task itself. */
  onStarted: (sessionId: SessionId, mode: 'new' | 'here') => void;
}

const AGENT_OPTIONS = SPAWN_AGENTS.filter((a) => a !== 'shell').map((a) => ({
  value: a,
  label: copy.agentProducts[a],
}));

/** Build it (#140): which screens, the design's type and colour, a note; in a new build task or here. */
export function HandoverDialog({ designSessionId, agent, design, onClose, onStarted }: HandoverDialogProps) {
  const h = copy.chat.design.handover;
  const [mode, setMode] = useState<'new' | 'here'>('new');
  const [pick, setPick] = useState<Agent>(agent);
  const [screens, setScreens] = useState<ReadonlySet<string>>(
    () => new Set(design.screens.map((x) => x.slug)),
  );
  const [tokens, setTokens] = useState(design.tokens !== null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { agent: useId(), note: useId() };
  const start = async () => {
    if (screens.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    const r = await command('design.handover', {
      sessionId: designSessionId,
      mode,
      agent: pick,
      screens: design.screens.map((x) => x.slug).filter((x) => screens.has(x)),
      tokens,
      note,
    });
    setBusy(false);
    if (r.ok) onStarted(r.value.sessionId, mode);
    else setError(r.error.message);
  };
  return (
    <Modal
      width={560}
      title={h.title}
      onClose={onClose}
      bodyPad="20px 16px"
      footer={
        <>
          <Button size="footer" variant="ghost" onClick={onClose}>
            {h.cancel}
          </Button>
          <Button
            size="footer"
            variant="accent"
            disabled={screens.size === 0 || busy}
            onClick={() => void start()}
            data-handover-start="true"
          >
            {h.start}
          </Button>
        </>
      }
    >
      <div className={s['handover']} data-handover="true">
        <p className={s['handoverBody']}>{h.body}</p>
        <div className={s['choice']} role="radiogroup" aria-label={h.title}>
          {(['new', 'here'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              data-inv={mode === m ? 'true' : undefined}
              className={s['choiceItem']}
              onClick={() => setMode(m)}
              data-handover-mode={m}
            >
              <b>{m === 'new' ? h.newTask : h.here}</b>
              <span>{m === 'new' ? h.newTaskBody : h.hereBody}</span>
            </button>
          ))}
        </div>
        {mode === 'new' ? (
          <label className={s['checkRow']} htmlFor={ids.agent}>
            <span>{h.agent}</span>
            <span className={s['agentPick']}>
              <AgentDot agent={pick} />
              <Select
                id={ids.agent}
                value={pick}
                options={AGENT_OPTIONS}
                onChange={(e) => {
                  const a = SPAWN_AGENTS.find((x) => x === e.currentTarget.value);
                  if (a !== undefined) setPick(a);
                }}
              />
            </span>
          </label>
        ) : null}
        {design.screens.map((screen) => (
          <div key={screen.slug} className={s['checkRow']}>
            <Checkbox
              checked={screens.has(screen.slug)}
              onChange={(on) =>
                setScreens((set) => {
                  const next = new Set(set);
                  if (on) next.add(screen.slug);
                  else next.delete(screen.slug);
                  return next;
                })
              }
              label={screen.name}
            />
            <span className={s['meta']}>
              {[...new Set(screen.files.map((f) => copy.chat.design.size[f.size]))].join(' · ')}
            </span>
          </div>
        ))}
        {design.tokens !== null ? (
          <div className={s['checkRow']}>
            <Checkbox checked={tokens} onChange={setTokens} label={h.tokens} />
            <span className={s['meta']}>
              {fill(h.tokensMeta, {
                colours: design.tokens.colors.length,
                sizes: design.tokens.scale.length,
              })}
            </span>
          </div>
        ) : null}
        <label htmlFor={ids.note} className="visually-hidden">
          {h.noteLabel}
        </label>
        <Textarea
          id={ids.note}
          minHeight={56}
          placeholder={h.note}
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
        {error !== null ? (
          <p role="alert" className={s['error']}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
