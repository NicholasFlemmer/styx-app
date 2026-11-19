import { copy, fill, oneTasks, type ReadModel } from '@styx/core';
import { Button } from '@styx/ui';
import { ChatPane } from '../../features/chat/ChatPane';
import { ShareConversation } from '../../features/hub/ShareConversation';
import { useModel, useNow, useSessionId, useUi } from '../../state/hooks';
import { ResultView } from './Results';
import s from './One.module.css';

const identity = (m: ReadModel) => m;

/**
 * One task in plain view (mockup frame 3): what it is and where it stands, the conversation with its results, and
 * the move that is the person's (answer, or go live). The developer depth (files, diff, terminal, preview, access)
 * is the workspace, one click away.
 */
export function OneTask() {
  const model = useModel(identity);
  const now = useNow();
  const sessionId = useSessionId();
  const projectId = useUi((u) => u.projectId);
  const setScreen = useUi((u) => u.setScreen);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const task =
    projectId === null || sessionId === null
      ? undefined
      : oneTasks(model, now, projectId).find((t) => t.sessionId === sessionId);
  if (task === undefined || projectId === null)
    return (
      <div className={s['page']} data-one-page="task">
        <p className={s['empty']}>{copy.one.taskGone}</p>
      </div>
    );
  const worktreeId = model.sessions.byId[task.sessionId]?.worktreeId;
  const result = model.taskResults[task.sessionId];
  return (
    <div className={s['taskView']} data-one-page="task">
      <header className={s['taskHead']}>
        <div className={s['taskHeadText']}>
          <h1 className={s['title']}>{task.title}</h1>
          <span className={s['state']} data-state={task.state}>
            {task.project} · {copy.one.taskKind[task.kind]} · {task.line}
          </span>
        </div>
        <div className={s['needActs']}>
          <ShareConversation sessionId={task.sessionId} messageId={null} />
          <Button size="regular" onClick={() => setScreen('workspace')}>
            {copy.one.showDetails}
          </Button>
        </div>
      </header>
      {task.state === 'ready' && worktreeId !== undefined ? (
        <div className={s['live']} data-one-live="true">
          <span>
            <b>{copy.one.needs.live}</b>
            <span className={s['needWhy']}>
              {' '}
              · {fill(copy.one.needs.liveDetail, { project: task.project })}
            </span>
          </span>
          <Button
            variant="accent"
            size="regular"
            onClick={() => pushOverlay({ kind: 'modal', modal: 'land', worktreeId })}
          >
            {copy.one.needs.goLive}
          </Button>
        </div>
      ) : null}
      {result === undefined ? (
        <div className={s['taskChat']}>
          <ChatPane projectId={projectId} sessionId={task.sessionId} compact />
        </div>
      ) : (
        // A campaign or report leads; the conversation sits beside it for changes.
        <div className={s['taskSplit']}>
          <div className={s['taskResult']}>
            <ResultView result={result} />
          </div>
          <div className={s['taskSide']}>
            <ChatPane projectId={projectId} sessionId={task.sessionId} compact />
          </div>
        </div>
      )}
    </div>
  );
}
