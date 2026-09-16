import { backgroundTasks, copy, fill, inboxRows } from '@styx/core';
import { RailTile } from '@styx/ui';
import { useCallback } from 'react';
import { openTask } from '../features/tasks/task-launch';
import { findOverlay } from '../overlays/stack';
import { useModel, useNow, useUi } from '../state/hooks';
import { isProjectSection, resolveSection } from '../screens/Settings/sections';
import s from './Shell.module.css';

/**
 * The global rail (owner layout, discrepancy #85): what belongs to the app rather than to a project, to the left of
 * the project switcher. Glyph tiles, top to bottom: All projects, Approvals (corner when the inbox has rows),
 * Tasks (corner when one needs you), and App settings at the foot. The project nav keeps only the project's own
 * places, so the two never mix.
 */
export function AppRail() {
  const screen = useUi((u) => u.screen);
  const setScreen = useUi((u) => u.setScreen);
  const settingsSection = useUi((u) => u.settingsSection);
  const setSettingsSection = useUi((u) => u.setSettingsSection);
  const now = useNow();
  const inbox = useModel(useCallback((m) => inboxRows(m, now).length, [now]));
  const tasksNeedYou = useModel(
    useCallback((m) => backgroundTasks(m).filter((t) => t.state === 'needs-you').length, []),
  );
  const taskOpen = useUi((u) => findOverlay(u.overlays, 'task') !== null);
  const onAppSettings = screen === 'settings' && !isProjectSection(resolveSection(settingsSection));
  const openAppSettings = () => {
    // Coming from the app rail means the app's own sections; a project section left over from the nav is swapped.
    if (isProjectSection(resolveSection(settingsSection))) setSettingsSection('app:general');
    setScreen('settings');
  };
  return (
    <nav className={s['appRail']} aria-label={copy.appRail.label} data-app-rail="true">
      <RailTile
        initials={copy.appRail.home.glyph}
        title={copy.appRail.home.title}
        active={screen === 'home'}
        current="page"
        onClick={() => setScreen('home')}
        data-app-rail-item="home"
      />
      <RailTile
        initials={copy.appRail.approvals.glyph}
        title={copy.appRail.approvals.title}
        active={screen === 'approvals'}
        current="page"
        needs={inbox > 0}
        needsLabel={fill(copy.appRail.inboxCount, { n: inbox })}
        onClick={() => setScreen('approvals')}
        data-app-rail-item="approvals"
      />
      <RailTile
        initials={copy.appRail.tasks.glyph}
        title={copy.appRail.tasks.title}
        needs={tasksNeedYou > 0}
        needsLabel={fill(copy.appRail.tasksNeedYou, { n: tasksNeedYou })}
        aria-haspopup="dialog"
        aria-expanded={taskOpen}
        onClick={() => openTask(null)}
        data-app-rail-item="tasks"
      />
      <div className={s['appRailFoot']}>
        <RailTile
          initials={copy.appRail.settings.glyph}
          title={copy.appRail.settings.title}
          active={onAppSettings}
          current="page"
          onClick={openAppSettings}
          data-app-rail-item="settings"
        />
      </div>
    </nav>
  );
}
