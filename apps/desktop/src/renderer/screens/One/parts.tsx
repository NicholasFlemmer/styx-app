import {
  copy,
  fill,
  rows,
  type OneNeed,
  type OneTask,
  type ProjectId,
  type ReadModel,
  type SessionId,
  type TaskKind,
} from '@styx/core';
import { AgentDot, Button } from '@styx/ui';
import { useState, type KeyboardEvent } from 'react';
import { useSpawnForm } from '../../features/modals/use-spawn-form';
import { useModel, useUi } from '../../state/hooks';
import s from './One.module.css';

export type AskKind = 'code' | 'campaign' | 'report' | 'design';

/** The four things a campaign always needs, and a report's period: all optional, the agent asks for the rest. */
interface Brief {
  goal: string;
  budget: string;
  when: string;
  where: string;
  period: string;
}
const EMPTY_BRIEF: Brief = { goal: '', budget: '', when: '', where: '', period: '' };

/** The person's words, then the brief as plain lines the agent reads. */
const withBrief = (text: string, kind: AskKind, b: Brief): string => {
  const c = copy.one.brief;
  const lines =
    kind === 'campaign'
      ? [
          b.goal && `${c.goal}: ${b.goal}`,
          b.budget && `${c.budget}: ${b.budget}`,
          b.when && `${c.when}: ${b.when}`,
          b.where && `${c.where}: ${b.where}`,
        ]
      : kind === 'report'
        ? [b.period && `${c.period}: ${b.period}`]
        : [];
  const filled = lines.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return filled.length === 0 ? text : `${text}\n\n${filled.join('\n')}`;
};
const ASK_KINDS: AskKind[] = ['code', 'campaign', 'report', 'design'];
/** What each choice starts: a build lane (no kind), or a design, campaign or report task. */
const KIND_OF: Record<AskKind, TaskKind | null> = {
  code: null,
  campaign: 'campaign',
  report: 'report',
  design: 'design',
};

const liveProjects = (m: ReadModel) => rows(m.projects).filter((p) => p.removedAt == null);

/** Opens a task in plain view (the details are one click on from there). */
export function useOpenTask(): (projectId: ProjectId, sessionId: SessionId) => void {
  const openSession = useUi((u) => u.openSession);
  const setScreen = useUi((u) => u.setScreen);
  return (projectId, sessionId) => {
    openSession(projectId, sessionId);
    setScreen('one-task');
  };
}

/** One task as a card: project and AI, the title, one plain line on where it stands. Opens the task. */
export function TaskCard({ task }: { task: OneTask }) {
  const openSession = useOpenTask();
  return (
    <button
      type="button"
      className={s['task']}
      data-on={task.state === 'your-turn' || task.state === 'ready' ? 'true' : undefined}
      data-one-task={task.sessionId}
      onClick={() => openSession(task.projectId, task.sessionId)}
    >
      <span className={s['taskMeta']}>
        <AgentDot agent={task.agent} />
        <span>{task.project}</span>
        <span aria-hidden="true">·</span>
        <span>{copy.one.taskKind[task.kind]}</span>
      </span>
      <span className={s['taskTitle']}>{task.title}</span>
      <span className={s['state']} data-state={task.state}>
        {task.line}
      </span>
    </button>
  );
}

export function TaskList({ tasks }: { tasks: OneTask[] }) {
  return (
    <ul className={s['tasks']} aria-label={copy.one.tasks.title}>
      {tasks.map((t) => (
        <li key={t.sessionId}>
          <TaskCard task={t} />
        </li>
      ))}
    </ul>
  );
}

/** One thing waiting on the person, its consequence in big type, and the move that is theirs. */
export function NeedCard({ need }: { need: OneNeed }) {
  const pushOverlay = useUi((u) => u.pushOverlay);
  const openSession = useOpenTask();
  const setProject = useUi((u) => u.setProject);
  const setScreen = useUi((u) => u.setScreen);
  const model = useModel((m) => m);
  const n = copy.one.needs;
  if (need.kind === 'access') {
    const ask =
      need.sessionId === null
        ? undefined
        : rows(model.pendingAsks).find((a) => a.grantId === need.grantId && a.state === 'open');
    const sessionId = need.sessionId;
    return (
      <div className={s['need']} data-one-need={need.key}>
        <span className={s['needWhat']}>{need.title}</span>
        <span className={s['needBig']}>{need.big}</span>
        <span className={s['needWhy']}>
          {need.osAuth ? `${n.accessProd} · ` : ''}"{need.reason}" · {need.project} · {need.age}
        </span>
        <span className={s['needActs']}>
          <Button
            variant="accent"
            size="regular"
            onClick={() => {
              if (sessionId !== null && ask !== undefined)
                pushOverlay({ kind: 'sheet', sheet: 'grant', sessionId, askId: ask.id });
              else if (sessionId !== null) openSession(need.projectId, sessionId);
              else {
                setProject(need.projectId);
                setScreen('approvals');
              }
            }}
          >
            {n.review}
          </Button>
        </span>
      </div>
    );
  }
  return (
    <div className={s['need']} data-one-need={need.key}>
      <span className={s['needWhat']}>{need.title}</span>
      <span className={s['needBig']}>{need.big}</span>
      <span className={s['needWhy']}>
        {need.kind === 'live' ? fill(n.liveDetail, { project: need.project }) : need.project} · {need.age}
      </span>
      <span className={s['needActs']}>
        {need.kind === 'live' ? (
          <Button
            variant="accent"
            size="regular"
            onClick={() => {
              const w = model.sessions.byId[need.sessionId]?.worktreeId;
              if (w !== undefined) pushOverlay({ kind: 'modal', modal: 'land', worktreeId: w });
            }}
          >
            {n.goLive}
          </Button>
        ) : (
          <Button variant="accent" size="regular" onClick={() => openSession(need.projectId, need.sessionId)}>
            {need.kind === 'launch' ? n.reviewLaunch : n.answer}
          </Button>
        )}
        {need.kind === 'live' ? (
          <Button size="regular" onClick={() => openSession(need.projectId, need.sessionId)}>
            {n.see}
          </Button>
        ) : null}
      </span>
    </div>
  );
}

export function NeedList({ needs }: { needs: OneNeed[] }) {
  if (needs.length === 0) return <p className={s['empty']}>{copy.one.needs.empty}</p>;
  return (
    <ul className={s['needs']} aria-label={copy.one.needs.title}>
      {needs.map((n) => (
        <li key={n.key}>
          <NeedCard need={n} />
        </li>
      ))}
    </ul>
  );
}

/**
 * "What do you want done?": the person's words become a new task in the chosen project, on its own branch, with
 * the project's default AI (the spawn form's defaults; the details stay in classic Styx's New task).
 */
/** What a starter puts in the ask box; `n` changes on every click, so the same starter can fill it twice. */
export interface AskPreset {
  kind: AskKind;
  text: string;
  n: number;
}

export function AskBox({ projectId: fixed, preset }: { projectId?: ProjectId; preset?: AskPreset | null }) {
  const projects = useModel(liveProjects);
  const current = useUi((u) => u.projectId);
  const [picked, setPicked] = useState<ProjectId | null>(null);
  const projectId =
    fixed ?? picked ?? (projects.some((p) => p.id === current) ? current : (projects[0]?.id ?? null));
  if (projectId === null) return <p className={s['empty']}>{copy.one.noProject}</p>;
  return (
    <AskForm
      key={`${projectId}:${preset?.n ?? 0}`}
      preset={preset ?? null}
      projectId={projectId}
      projects={fixed === undefined ? projects : []}
      onPick={setPicked}
    />
  );
}

function AskForm({
  preset,
  projectId,
  projects,
  onPick,
}: {
  preset: AskPreset | null;
  projectId: ProjectId;
  projects: { id: ProjectId; name: string }[];
  onPick: (id: ProjectId) => void;
}) {
  const { valid, busy, spawn, missing } = useSpawnForm(projectId);
  const openSession = useOpenTask();
  const [text, setText] = useState(preset?.text ?? '');
  const [kind, setKind] = useState<AskKind>(preset?.kind ?? 'code');
  const [brief, setBrief] = useState<Brief>(EMPTY_BRIEF);
  const b = copy.one.brief;
  const [error, setError] = useState<string | null>(null);
  const can = text.trim() !== '' && valid && !busy && !missing;
  const start = async () => {
    if (!can) return;
    setError(null);
    const id = await spawn(withBrief(text.trim(), kind, brief), KIND_OF[kind]);
    if (id === null) {
      setError(copy.one.startFailed);
      return;
    }
    setText('');
    openSession(projectId, id);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void start();
    }
  };
  return (
    <div className={s['ask']} data-one-ask="true">
      <textarea
        className={s['askInput']}
        aria-label={copy.one.ask}
        placeholder={copy.one.askPlaceholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <div className={s['askRow']} role="group" aria-label={copy.one.kindLabel}>
        {ASK_KINDS.map((k) => (
          <Button
            key={k}
            size="compact"
            inv={kind === k}
            aria-pressed={kind === k}
            title={copy.one.kindHint[k]}
            onClick={() => setKind(k)}
          >
            {copy.one.kinds[k]}
          </Button>
        ))}
        <span className={s['needWhy']}>{copy.one.kindHint[kind]}</span>
      </div>
      {kind === 'campaign' || kind === 'report' ? (
        <div className={s['briefFields']} role="group" aria-label={b.label}>
          {kind === 'campaign' ? (
            <>
              <label className={s['field']}>
                <span>{b.goal}</span>
                <select
                  className={s['askSelect']}
                  value={brief.goal}
                  onChange={(e) => setBrief({ ...brief, goal: e.target.value })}
                >
                  <option value="">{b.any}</option>
                  {b.goals.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </label>
              <label className={s['field']}>
                <span>{b.budget}</span>
                <input
                  className={s['askSelect']}
                  value={brief.budget}
                  placeholder={b.budgetHint}
                  onChange={(e) => setBrief({ ...brief, budget: e.target.value })}
                />
              </label>
              <label className={s['field']}>
                <span>{b.when}</span>
                <input
                  className={s['askSelect']}
                  value={brief.when}
                  placeholder={b.whenHint}
                  onChange={(e) => setBrief({ ...brief, when: e.target.value })}
                />
              </label>
              <label className={s['field']}>
                <span>{b.where}</span>
                <input
                  className={s['askSelect']}
                  value={brief.where}
                  placeholder={b.whereHint}
                  onChange={(e) => setBrief({ ...brief, where: e.target.value })}
                />
              </label>
            </>
          ) : (
            <label className={s['field']}>
              <span>{b.period}</span>
              <select
                className={s['askSelect']}
                value={brief.period}
                onChange={(e) => setBrief({ ...brief, period: e.target.value })}
              >
                <option value="">{b.any}</option>
                {b.periods.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className={s['needWhy']}>{b.optional}</span>
        </div>
      ) : null}
      <div className={s['askRow']}>
        {projects.length > 1 ? (
          <label>
            {copy.one.startIn}{' '}
            <select
              className={s['askSelect']}
              value={projectId}
              onChange={(e) => onPick(e.target.value as ProjectId)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {error === null ? null : (
          <span className={s['askError']} role="alert">
            {error}
          </span>
        )}
        <span className={s['push']} />
        <Button variant="accent" size="regular" disabled={!can} onClick={() => void start()}>
          {copy.one.start}
        </Button>
      </div>
    </div>
  );
}
