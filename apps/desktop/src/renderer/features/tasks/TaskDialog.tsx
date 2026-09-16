import {
  backgroundTasks,
  copy,
  headAskOf,
  projectNameOf,
  taskKey,
  taskTitle,
  type AskResolution,
  type PendingAsk,
  type Session,
} from '@styx/core';
import { Button, Input, Markdown, QuestionSet, StatusDot } from '@styx/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import { startLearnDeploy, startLearnRun } from '../abilities/learn';
import { startDebtAudit } from '../audit';
import { openTask } from './task-launch';
import s from './TaskDialog.module.css';

function TaskAsk({ ask }: { ask: PendingAsk }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const respond = async (resolution: AskResolution) => {
    setBusy(true);
    try {
      await command('ask.respond', { askId: ask.id, resolution });
    } finally {
      setBusy(false);
    }
  };
  const p = ask.payload;
  switch (p.kind) {
    case 'grant':
      return (
        <Button
          variant="primary"
          onClick={() =>
            pushOverlay({ kind: 'sheet', sheet: 'grant', sessionId: ask.sessionId, askId: ask.id })
          }
        >
          {copy.tasks.reviewGrant}
        </Button>
      );
    case 'questions':
      return (
        <QuestionSet
          questions={p.questions}
          answers={null}
          disabled={busy}
          onSubmit={(answers) => void respond({ kind: 'questions', answers })}
          header={copy.session.questions.header(p.questions.length)}
          submitLabel={copy.session.questions.submit}
          freeTextPlaceholder={copy.session.questions.freeText}
          secretPlaceholder={copy.session.questions.secret}
        />
      );
    case 'decision':
      return (
        <div>
          <Markdown text={p.prompt} />
          <div className={s['actions']}>
            {p.options.map((chosen) => (
              <Button key={chosen} disabled={busy} onClick={() => void respond({ kind: 'decision', chosen })}>
                {chosen}
              </Button>
            ))}
          </div>
        </div>
      );
    case 'plan':
      return (
        <div>
          <Markdown text={p.summary} />
          <div className={s['actions']}>
            <Button
              disabled={busy}
              onClick={() => void respond({ kind: 'plan', outcome: 'approved', note: null })}
            >
              {copy.session.plan.approve}
            </Button>
            <Button
              disabled={busy}
              onClick={() => void respond({ kind: 'plan', outcome: 'rejected', note: null })}
            >
              {copy.session.plan.reject}
            </Button>
          </div>
        </div>
      );
    case 'question':
      return (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (answer.trim()) void respond({ kind: 'question', answer });
          }}
        >
          <label>
            <Markdown text={p.prompt} />
            <Input value={answer} disabled={busy} onChange={(e) => setAnswer(e.target.value)} />
          </label>
          <Button type="submit" disabled={busy || !answer.trim()}>
            {copy.tasks.answer}
          </Button>
        </form>
      );
  }
}

export const taskStatus = (session: Session): string => {
  if (session.state === 'needs-you') return copy.tasks.needsYou;
  if (session.state === 'paused') return copy.tasks.paused;
  if (session.state === 'done')
    return session.exitCode === 0
      ? copy.tasks.finished
      : session.exitCode === null
        ? copy.tasks.stopped
        : copy.tasks.failed;
  return copy.tasks.working;
};

/** Modeless progress dialog: navigation remains interactive; all work belongs to main, not this component. */
export function TaskDialog({ id, selectedKey }: { id: string; selectedKey: string | null }) {
  const model = useModel((m) => m);
  const launches = useUi((u) => u.taskLaunches);
  const popOverlay = useUi((u) => u.popOverlay);
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current?.focus(), []);
  const tasks = backgroundTasks(model);
  const launch = selectedKey === null ? undefined : launches[selectedKey];
  const launching = launch && (!launch.sessionId || !model.sessions.byId[launch.sessionId]);
  const session = launching ? undefined : tasks.find((t) => taskKey(t) === selectedKey);
  const projectId = session?.projectId ?? launch?.projectId;
  const purpose = session?.purpose ?? launch?.purpose;
  const targetId = selectedKey?.startsWith('deploy:') ? selectedKey.slice(7) : '';
  const title = selectedKey === null ? copy.tasks.title : taskTitle(purpose, model.targets.byId[targetId]);
  const ask = session ? headAskOf(model, session.id) : null;
  const messages = session ? (model.transcripts[session.id] ?? []) : [];
  const output = messages.filter((m) => m.payload.kind === 'agent').at(-1)?.body;
  const activity = messages.filter((m) => m.payload.kind === 'tool' || m.payload.kind === 'system').slice(-8);
  const error = launch?.error;
  const busy = !error && (session === undefined || session.state !== 'done');
  const status = error ? copy.tasks.failed : session ? taskStatus(session) : copy.tasks.starting;
  const retry = () => {
    if (!projectId) return;
    if (purpose === 'debt-audit') void startDebtAudit(model, projectId);
    else if (purpose === 'learn-run') void startLearnRun(model, projectId);
    else if (selectedKey?.startsWith('deploy:')) {
      const target = model.targets.byId[selectedKey.slice('deploy:'.length)];
      if (target) void startLearnDeploy(model, target);
    }
  };
  const entries = new Map<string, { title: string; project: string; status: string }>();
  for (const t of tasks) {
    const key = taskKey(t);
    if (!entries.has(key))
      entries.set(key, {
        title: taskTitle(t.purpose, model.targets.byId[t.taskTargetId ?? '']),
        project: projectNameOf(model, t.projectId),
        status: taskStatus(t),
      });
  }
  for (const l of Object.values(launches)) {
    if (l.sessionId && model.sessions.byId[l.sessionId]) continue;
    entries.set(l.key, {
      title: taskTitle(l.purpose, model.targets.byId[l.key.slice(7)]),
      project: projectNameOf(model, l.projectId),
      status: l.error ? copy.tasks.failed : copy.tasks.starting,
    });
  }

  return (
    <section
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className={s['panel']}
      data-task-dialog="true"
      data-busy={busy ? 'true' : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          popOverlay(id);
        }
      }}
    >
      <div className={s['header']}>
        <span id={titleId} className="t-label">
          {title}
          {projectId ? ` · ${projectNameOf(model, projectId)}` : ''}
        </span>
        <Button size="compact" onClick={() => popOverlay(id)} aria-label={copy.tasks.close}>
          ×
        </Button>
      </div>
      <div className={s['body']}>
        {selectedKey === null ? (
          <div className={s['list']}>
            {entries.size === 0 ? (
              <p>{copy.tasks.empty}</p>
            ) : (
              [...entries].map(([key, entry]) => (
                <button key={key} type="button" className={s['entry']} onClick={() => openTask(key)}>
                  <span>
                    {entry.title} · {entry.project}
                  </span>
                  <span>{entry.status}</span>
                </button>
              ))
            )}
          </div>
        ) : (
          <>
            <div role="status" className={s['status']}>
              <StatusDot tone={ask ? 'accent' : 'text'} />
              {status}
            </div>
            <p className={s['hint']}>{copy.tasks.hint}</p>
            {error ? <p role="alert">{error}</p> : null}
            {session?.note && !ask ? <p>{session.note}</p> : null}
            {session?.state === 'paused' ? (
              <Button onClick={() => void command('session.resume', { sessionId: session.id })}>
                {copy.chat.controls.resume}
              </Button>
            ) : null}
            {ask ? <TaskAsk key={ask.id} ask={ask} /> : null}
            {output ? (
              <div className={s['result']}>
                <Markdown text={output} />
              </div>
            ) : !busy && !error ? (
              <p>{copy.tasks.noResult}</p>
            ) : null}
            {activity.length > 0 ? (
              <details>
                <summary>{copy.tasks.details}</summary>
                {activity.map((m) => (
                  <p key={m.id} className={s['activity']}>
                    {m.payload.kind === 'tool'
                      ? `${m.payload.tool} · ${m.payload.hint} · ${m.payload.status}`
                      : m.body}
                  </p>
                ))}
              </details>
            ) : null}
          </>
        )}
      </div>
      <div className={s['actions']}>
        {selectedKey !== null ? <Button onClick={() => openTask(null)}>{copy.tasks.title}</Button> : null}
        {session && session.state !== 'done' ? (
          <Button onClick={() => void command('session.stop', { sessionId: session.id })}>
            {copy.tasks.stop}
          </Button>
        ) : null}
        {selectedKey !== null && !busy ? (
          <Button onClick={retry}>{session?.exitCode === 0 ? copy.tasks.again : copy.tasks.retry}</Button>
        ) : null}
        <Button variant="primary" onClick={() => popOverlay(id)}>
          {selectedKey !== null && busy ? copy.tasks.background : copy.tasks.close}
        </Button>
      </div>
    </section>
  );
}
