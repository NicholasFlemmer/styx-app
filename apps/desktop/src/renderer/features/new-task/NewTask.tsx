import { copy, fill, navLanes, platformCopy, projectNameOf, type ProjectId } from '@styx/core';
import { AgentDot, Button, Checkbox, Field, Input, Select, StatusDot, Textarea } from '@styx/ui';
import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { useCopyPlatform, useNow, useUi } from '../../state/hooks';
import {
  decodeEffort,
  decodePermissionMode,
  effortOptionsFor,
  encodeNullable,
  modelOptionsFor,
  permissionModeHint,
  permissionModeOptionsFor,
} from '../chat/session-controls';
import { SPAWN_AGENTS, cliOf, cliVersionLabel } from '../modals/modals';
import { useSpawnForm } from '../modals/use-spawn-form';
import s from './NewTask.module.css';

export interface NewTaskProps {
  projectId: ProjectId;
  /** Text to start from (the palette's "Start as a task"). */
  initialText?: string;
}

/**
 * New task (ADR-0027 §1), in the workspace instead of a modal: one box and Start, with sensible defaults. Every
 * field the Spawn dialog asks is under it, already filled in (agent, where, branch, permissions, model, effort,
 * the three toggles), with the same CLI-missing and signed-out rows. Three general starters for a first task, and
 * what is already running in the project beside it. Mod+⏎ starts; Escape or Back returns to the work.
 */
export function NewTask({ projectId, initialText = '' }: NewTaskProps) {
  const openNewTask = useUi((u) => u.openNewTask);
  const openSession = useUi((u) => u.openSession);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const platform = useUi((u) => u.platform);
  const words = platformCopy(useCopyPlatform());
  const now = useNow();
  const spawnForm = useSpawnForm(projectId, initialText);
  const {
    model,
    form,
    setForm,
    pickAgent,
    pickModel,
    setBranch,
    catalogue,
    missing,
    notConnected,
    valid,
    spawn,
    locateError,
    locateBinary,
    installGuide,
    worktrees,
    choices,
    settings,
  } = spawnForm;
  const project = projectNameOf(model, projectId);
  const box = useRef<HTMLTextAreaElement>(null);
  const ids = {
    task: useId(),
    where: useId(),
    branch: useId(),
    mode: useId(),
    model: useId(),
    effort: useId(),
  };
  const lanes = navLanes(model, projectId, now).filter((l) => l.status !== 'landed');
  const agentName = copy.agentProducts[form.agent];

  useEffect(() => {
    box.current?.focus();
  }, []);

  const start = async (text = form.firstMessage) => {
    if (text.trim() === '') {
      box.current?.focus();
      return;
    }
    if (text !== form.firstMessage) setForm((f) => ({ ...f, firstMessage: text }));
    const sessionId = await spawn(text);
    if (sessionId !== null) openSession(projectId, sessionId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      openNewTask(null);
      return;
    }
    const mod = platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      void start();
    }
  };
  const ready = valid && form.firstMessage.trim() !== '';

  return (
    <div className={s['root']} onKeyDown={onKeyDown} data-new-task={projectId}>
      <section className={s['main']} aria-labelledby="new-task-title">
        <h2 id="new-task-title" className={s['headline']}>
          {copy.newTask.headline}
          <br />
          <span>{fill(copy.newTask.in, { project })}</span>
        </h2>

        <div className={s['composer']}>
          <label htmlFor={ids.task} className="visually-hidden">
            {copy.newTask.label}
          </label>
          <Textarea
            ref={box}
            id={ids.task}
            className={s['text']}
            minHeight={84}
            placeholder={copy.newTask.placeholder}
            value={form.firstMessage}
            onChange={(e) => setForm({ ...form, firstMessage: e.currentTarget.value })}
            data-new-task-text="true"
          />
          <div className={s['row']}>
            <span className={s['safe']}>{copy.newTask.safe}</span>
            <Button variant="ghost" onClick={() => openNewTask(null)}>
              {copy.newTask.back}
            </Button>
            <Button
              variant="accent"
              disabled={!ready}
              onClick={() => void start()}
              data-new-task-start="true"
            >
              {copy.newTask.start} <kbd className={s['kbd']}>{words.mod}⏎</kbd>
            </Button>
          </div>
        </div>

        <div className={s['agents']} role="radiogroup" aria-label={copy.newTask.agent}>
          {SPAWN_AGENTS.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={a === form.agent}
              data-inv={a === form.agent ? 'true' : undefined}
              data-agent={a}
              className={s['agent']}
              onClick={() => pickAgent(a)}
            >
              <span className={s['agentName']}>
                <AgentDot agent={a} />
                {copy.agentProducts[a]}
              </span>
              <span className={s['agentVer']}>{cliVersionLabel(cliOf(model, a))}</span>
            </button>
          ))}
        </div>

        {missing || notConnected ? (
          <div className={s['error']} role="status" data-spawn-cli={missing ? 'missing' : 'not-connected'}>
            <StatusDot tone="accent" />
            <span className={s['errorText']}>
              {missing
                ? fill(copy.errors.spawnCliMissing, { cli: agentName })
                : fill(copy.errors.spawnNotConnected, { cli: agentName })}
            </span>
            {missing ? (
              <>
                <Button onClick={installGuide}>{copy.errors.cliMissing.cta}</Button>
                <Button onClick={() => void locateBinary()}>{copy.errors.locateBinary}</Button>
              </>
            ) : null}
            <Button onClick={() => pushOverlay({ kind: 'modal', modal: 'connect-agent', agent: form.agent })}>
              {copy.errors.fixConnection}
            </Button>
          </div>
        ) : null}
        {missing && locateError !== null ? (
          <div className={s['error']} role="alert">
            <span className={s['errorText']}>{locateError}</span>
          </div>
        ) : null}

        <div className={s['fields']}>
          <Field label={copy.spawn.worktree} htmlFor={ids.where}>
            <Select
              id={ids.where}
              width="100%"
              value={form.worktree}
              onChange={(e) => setForm({ ...form, worktree: e.currentTarget.value })}
              options={choices.options}
            />
          </Field>
          <Field label={copy.spawn.branch} htmlFor={ids.branch}>
            <Input
              id={ids.branch}
              mono
              value={
                form.worktree === 'new'
                  ? form.branch
                  : (worktrees.find((w) => w.id === form.worktree)?.branch ?? '')
              }
              disabled={form.worktree !== 'new'}
              spellCheck={false}
              onChange={(e) => setBranch(e.currentTarget.value)}
            />
          </Field>
          {settings.mode ? (
            <Field
              label={copy.chat.controls.permissions}
              htmlFor={ids.mode}
              hint={permissionModeHint(form.agent, form.permissionMode)}
            >
              <Select
                id={ids.mode}
                width="100%"
                value={form.permissionMode}
                onChange={(e) =>
                  setForm({ ...form, permissionMode: decodePermissionMode(e.currentTarget.value) })
                }
                options={permissionModeOptionsFor(form.agent).map((o) => ({
                  value: o.value,
                  label: o.label,
                }))}
              />
            </Field>
          ) : null}
          {settings.model ? (
            <Field label={copy.chat.controls.model} htmlFor={ids.model}>
              <Select
                id={ids.model}
                width="100%"
                value={encodeNullable(form.model)}
                onChange={(e) => pickModel(e.currentTarget.value)}
                options={modelOptionsFor(form.agent, form.model, catalogue)}
              />
            </Field>
          ) : null}
          {settings.effort ? (
            <Field label={copy.chat.controls.effort} htmlFor={ids.effort}>
              <Select
                id={ids.effort}
                width="100%"
                value={encodeNullable(form.effort)}
                onChange={(e) => setForm({ ...form, effort: decodeEffort(e.currentTarget.value) })}
                options={effortOptionsFor(form.agent, form.model, catalogue, form.effort)}
              />
            </Field>
          ) : null}
        </div>

        <div className={s['toggles']}>
          <Checkbox
            checked={form.toggles.autoApproveEdits}
            onChange={(v) => setForm({ ...form, toggles: { ...form.toggles, autoApproveEdits: v } })}
            label={copy.spawn.toggles.autoApproveEdits}
          />
          <Checkbox
            checked={form.toggles.mayRequestTargets}
            onChange={(v) => setForm({ ...form, toggles: { ...form.toggles, mayRequestTargets: v } })}
            label={copy.spawn.toggles.mayRequestTargets}
          />
          <Checkbox
            checked={form.toggles.notifyWhenNeedsMe}
            onChange={(v) => setForm({ ...form, toggles: { ...form.toggles, notifyWhenNeedsMe: v } })}
            label={copy.spawn.toggles.notifyWhenNeedsMe}
          />
        </div>

        <div className={s['starters']} data-new-task-starters="true">
          <h3 className={s['startersHead']}>{copy.newTask.startersHeading}</h3>
          {copy.newTask.starters.map((st) => (
            <div key={st.title} className={s['starter']}>
              <div>
                <div className={s['starterTitle']}>{st.title}</div>
                <div className={s['starterBody']}>{st.body}</div>
              </div>
              <span className={s['starterMeta']}>{st.meta}</span>
              <Button size="compact" disabled={!valid} onClick={() => void start(st.prompt)}>
                {copy.newTask.startThis}
              </Button>
            </div>
          ))}
        </div>
      </section>

      <aside className={s['running']} aria-label={fill(copy.newTask.running, { project })}>
        <h3 className={s['runningHead']}>{fill(copy.newTask.running, { project })}</h3>
        {lanes.length === 0 ? <p className={s['runningNone']}>{copy.newTask.runningNone}</p> : null}
        {lanes.map((l) => (
          <button
            key={l.sessionId}
            type="button"
            className={s['lane']}
            onClick={() => openSession(projectId, l.sessionId)}
          >
            <span className={s['laneWho']}>
              <AgentDot agent={l.agent} />
              {l.statusLabel}
            </span>
            <span className={s['laneTask']}>{l.task}</span>
          </button>
        ))}
      </aside>
    </div>
  );
}
