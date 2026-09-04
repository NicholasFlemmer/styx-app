import type { ProjectId, SessionId } from '../ids';
import type { Session } from '../model/session';
import type { ReadModel } from '../read-model';
import { agentLabel, sessionsInProject } from './common';

export type TabDot = 'accent' | 'text' | 'line';

export interface SessionTab {
  sessionId: SessionId;
  label: string;
  active: boolean;
  needs: boolean;
  dot: TabDot;
}

export interface SessionTabs {
  visible: SessionTab[];
  overflow: SessionTab[];
  activeId: SessionId | null;
}

export const MAX_VISIBLE_TABS = 3;

const dotFor = (s: Session): TabDot =>
  s.state === 'needs-you' ? 'accent' : s.state === 'working' ? 'text' : 'line';

/**
 * Chat tabs for a project: sessions that are not done, in spawn order; 3 visible, the rest in ▾.
 * When the active session is in the overflow it takes slot 3. Falls back to the first tab when
 * `activeId` is not in the project.
 */
export const sessionTabs = (
  model: ReadModel,
  projectId: ProjectId,
  activeId: SessionId | null,
): SessionTabs => {
  const sessions = sessionsInProject(model, projectId)
    .filter((s) => s.state !== 'done')
    .sort((a, b) => a.startedAt - b.startedAt);
  const resolvedActive = sessions.find((s) => s.id === activeId)?.id ?? sessions[0]?.id ?? null;
  const toTab = (s: Session): SessionTab => ({
    sessionId: s.id,
    label: agentLabel(s),
    active: s.id === resolvedActive,
    needs: s.state === 'needs-you',
    dot: dotFor(s),
  });
  let visible = sessions.slice(0, MAX_VISIBLE_TABS);
  let overflow = sessions.slice(MAX_VISIBLE_TABS);
  const activeInOverflow = overflow.find((s) => s.id === resolvedActive);
  if (activeInOverflow !== undefined) {
    const displaced = visible.slice(MAX_VISIBLE_TABS - 1);
    visible = [...visible.slice(0, MAX_VISIBLE_TABS - 1), activeInOverflow];
    overflow = [...displaced, ...overflow.filter((s) => s.id !== activeInOverflow.id)];
  }
  return { visible: visible.map(toTab), overflow: overflow.map(toTab), activeId: resolvedActive };
};
