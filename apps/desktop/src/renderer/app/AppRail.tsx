import { backgroundTasks, copy, fill, inboxRows } from '@styx/core';
import { RailTile, type IconName } from '@styx/ui';
import { useCallback } from 'react';
import { openTask } from '../features/tasks/task-launch';
import { findOverlay } from '../overlays/stack';
import { APP_SECTIONS, resolveSection, type AppSection } from '../screens/Settings/sections';
import { useModel, useNow, useUi } from '../state/hooks';
import s from './Shell.module.css';

/** The icon each App settings section wears on the rail. */
const SECTION_ICON: Record<AppSection, IconName> = {
  'app:general': 'general',
  'app:account': 'account',
  'app:editor': 'editor',
  'app:agents': 'connections',
  'app:skills': 'skills',
  'app:keychain': 'keychain',
  'app:policies': 'policies',
  'app:shortcuts': 'shortcuts',
};

/**
 * The global rail (owner layout, discrepancies #85 / #87): what belongs to the app rather than to a project, to
 * the left of the project switcher. Icon tiles, top to bottom: All projects, All agents (every project's
 * sessions), Approvals (corner + count while the inbox has rows), Tasks (corner + count while one needs you), a
 * divider, then every App settings section as its own tile so nothing hides behind a menu. The project nav keeps
 * only the project's own places, so the two never mix.
 */
export function AppRail() {
  const screen = useUi((u) => u.screen);
  const setScreen = useUi((u) => u.setScreen);
  const settingsSection = useUi((u) => u.settingsSection);
  const setSettingsSection = useUi((u) => u.setSettingsSection);
  const setBoardScope = useUi((u) => u.setBoardScope);
  const boardScope = useUi((u) => u.boardScope);
  const now = useNow();
  const inbox = useModel(useCallback((m) => inboxRows(m, now).length, [now]));
  const tasksNeedYou = useModel(
    useCallback((m) => backgroundTasks(m).filter((t) => t.state === 'needs-you').length, []),
  );
  const taskOpen = useUi((u) => findOverlay(u.overlays, 'task') !== null);
  const section = resolveSection(settingsSection);
  const openSection = (id: AppSection) => {
    setSettingsSection(id);
    setScreen('settings');
  };
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
      <div className={s['appRailDivider']} role="presentation" />
      {APP_SECTIONS.map((id) => (
        <RailTile
          key={id}
          icon={SECTION_ICON[id]}
          title={copy.appRail.sections[id]}
          active={screen === 'settings' && section === id}
          current="page"
          onClick={() => openSection(id)}
          data-app-rail-item={id}
        />
      ))}
    </nav>
  );
}
