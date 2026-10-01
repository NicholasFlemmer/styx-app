import { backgroundTasks, copy, fill, inboxRows } from '@styx/core';
import { RailTile } from '@styx/ui';
import { useCallback } from 'react';
import { openTask } from '../features/tasks/task-launch';
import { findOverlay } from '../overlays/stack';
import { DEFAULT_APP_SECTION, isProjectSection, resolveSection } from '../screens/Settings/sections';
import { useModel, useNow, useUi } from '../state/hooks';
import s from './Shell.module.css';

/**
 * The app's places (ADR-0027 §5), at the top of the single rail column: All projects, All agents (every
 * project's sessions), Access (corner + count while the inbox has rows), Tasks (corner + count while one needs
 * you) and Usage. The project tiles follow, then Settings at the foot (`RailSettings`); the eight app settings
 * sections that used to have tiles here live in the Settings screen's own nav.
 */
export function AppRail() {
  const screen = useUi((u) => u.screen);
  const setScreen = useUi((u) => u.setScreen);
  const setBoardScope = useUi((u) => u.setBoardScope);
  const boardScope = useUi((u) => u.boardScope);
  const now = useNow();
  const inbox = useModel(useCallback((m) => inboxRows(m, now).length, [now]));
  const tasksNeedYou = useModel(
    useCallback((m) => backgroundTasks(m).filter((t) => t.state === 'needs-you').length, []),
  );
  const taskOpen = useUi((u) => findOverlay(u.overlays, 'task') !== null);
  return (
    <nav className={s['appRail']} aria-label={copy.appRail.label} data-app-rail="true">
      <RailTile
        icon="projects"
        title={copy.appRail.home.title}
        active={screen === 'home'}
        current="page"
        onClick={() => setScreen('home')}
        data-app-rail-item="home"
      />
      <RailTile
        icon="agents"
        title={copy.appRail.agents.title}
        active={screen === 'agents' && boardScope === 'all'}
        current="page"
        onClick={() => {
          setBoardScope('all');
          setScreen('agents');
        }}
        data-app-rail-item="agents"
      />
      <RailTile
        icon="approvals"
        title={copy.appRail.approvals.title}
        active={screen === 'approvals'}
        current="page"
        needs={inbox > 0}
        needsLabel={fill(copy.appRail.inboxCount, { n: inbox })}
        onClick={() => setScreen('approvals')}
        data-app-rail-item="approvals"
      />
      <RailTile
        icon="tasks"
        title={copy.appRail.tasks.title}
        needs={tasksNeedYou > 0}
        needsLabel={fill(copy.appRail.tasksNeedYou, { n: tasksNeedYou })}
        aria-haspopup="dialog"
        aria-expanded={taskOpen}
        onClick={() => openTask(null)}
        data-app-rail-item="tasks"
      />
      <RailTile
        icon="usage"
        title={copy.appRail.usage.title}
        active={screen === 'usage'}
        current="page"
        onClick={() => setScreen('usage')}
        data-app-rail-item="usage"
      />
    </nav>
  );
}

/** Settings at the foot of the rail (ADR-0027 §5): the app's settings, apart from any project. */
export function RailSettings() {
  const screen = useUi((u) => u.screen);
  const setScreen = useUi((u) => u.setScreen);
  const section = resolveSection(useUi((u) => u.settingsSection));
  const setSettingsSection = useUi((u) => u.setSettingsSection);
  const appSettings = screen === 'settings' && !isProjectSection(section);
  return (
    <div className={s['railFoot']}>
      <RailTile
        icon="general"
        title={copy.appRail.settings.title}
        active={appSettings}
        current="page"
        onClick={() => {
          // The app's settings, not a project's: those live in the project nav.
          if (isProjectSection(section)) setSettingsSection(DEFAULT_APP_SECTION);
          setScreen('settings');
        }}
        data-app-rail-item="settings"
      />
    </div>
  );
}
