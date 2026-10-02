import { copy, fill, type HomeProjectRow, type ProjectId, type SessionId } from '@styx/core';
import { AgentDot, StatusDot } from '@styx/ui';
import s from './Home.module.css';

/** How many lanes a project row shows before "+n more". */
const ROW_LANES = 3;

export interface ProjectTableProps {
  rows: readonly HomeProjectRow[];
  onOpen: (projectId: ProjectId) => void;
  onOpenLane: (projectId: ProjectId, sessionId: SessionId) => void;
  onNewTask: (projectId: ProjectId) => void;
}

/**
 * All projects, one row each (ADR-0027): the project and where it is, then its work as lanes (task, agent, whose
 * move it is) rather than agent names, then its targets and last activity. The row opens the project's
 * workspace; a lane chip opens that lane; a project with nothing running offers to start a task.
 */
export function ProjectTable({ rows, onOpen, onOpenLane, onNewTask }: ProjectTableProps) {
  return (
    <ul className={s['projects']} aria-label={copy.counters.projects}>
      {rows.map((p) => {
        const shown = p.lanes.slice(0, ROW_LANES);
        const more = p.lanes.length - shown.length;
        return (
          <li key={p.projectId} className={s['project']} data-project-id={p.projectId}>
            <button type="button" className={s['projectOpen']} onClick={() => onOpen(p.projectId)}>
              <span className={s['projectName']}>
                <StatusDot
                  tone="hollow"
                  on={p.needs}
                  {...(p.needs ? { label: copy.counters.needsYou } : {})}
                />
                {p.name}
              </span>
              <span className={s['projectPath']}>
                {p.path}, {p.branch}
              </span>
            </button>
            <div className={s['work']}>
              {shown.map((l) => (
                <button
                  key={l.sessionId}
                  type="button"
                  className={s['chip']}
                  data-status={l.status}
                  onClick={() => onOpenLane(p.projectId, l.sessionId)}
                  data-home-lane={l.sessionId}
                >
                  <AgentDot agent={l.agent} />
                  <span className={s['chipTask']}>{l.task}</span>
                  {l.status === 'your-turn' ? (
                    <em className={s['chipYours']}>{l.statusLabel}</em>
                  ) : (
                    <span className={s['chipStatus']}>{l.statusLabel}</span>
                  )}
                </button>
              ))}
              {more > 0 ? <span className={s['more']}>{fill(copy.home.moreLanes, { n: more })}</span> : null}
              {p.lanes.length === 0 ? (
                <span className={s['idle']}>
                  {copy.home.nothingRunning}{' '}
                  <button type="button" className={s['startTask']} onClick={() => onNewTask(p.projectId)}>
                    {copy.home.startTask}
                  </button>
                </span>
              ) : null}
            </div>
            <div className={s['meta']}>
              <span>{p.targets}</span>
              <span>{p.last}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
