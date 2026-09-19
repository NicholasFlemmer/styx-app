import { useEffect, useRef, type ComponentType } from 'react';
import { Agents } from '../screens/Agents/Agents';
import { Approvals } from '../screens/Approvals/Approvals';
import { Diff } from '../screens/Diff/Diff';
import { Home } from '../screens/Home/Home';
import { Onboarding } from '../screens/Onboarding/Onboarding';
import { Repo } from '../screens/Repo/Repo';
import { Settings } from '../screens/Settings/Settings';
import { Usage } from '../screens/Usage/Usage';
import { Workspace } from '../screens/Workspace/Workspace';
import { useUi } from '../state/hooks';
import type { Screen } from '../state/ui-store';
import s from './Shell.module.css';

const SCREENS: Record<Screen, ComponentType> = {
  home: Home,
  workspace: Workspace,
  agents: Agents,
  repo: Repo,
  approvals: Approvals,
  settings: Settings,
  usage: Usage,
  diff: Diff,
  onboarding: Onboarding,
};

/** Key scope carried by the content region for the current screen. */
const SCOPE_OF: Partial<Record<Screen, string>> = { workspace: 'workspace', diff: 'diff' };

function Outlet({ screen }: { screen: Screen }) {
  const root = useRef<HTMLDivElement>(null);
  const Component = SCREENS[screen];
  // `data-screen-ready` is set after mount so the visual harness waits for a painted screen.
  useEffect(() => {
    root.current?.setAttribute('data-screen-ready', screen);
  }, [screen]);
  return (
    <div ref={root} className={s['content']} data-screen={screen} data-keyscope={SCOPE_OF[screen]}>
      <Component />
    </div>
  );
}

export function ScreenOutlet() {
  const screen = useUi((u) => u.screen);
  return <Outlet key={screen} screen={screen} />;
}
