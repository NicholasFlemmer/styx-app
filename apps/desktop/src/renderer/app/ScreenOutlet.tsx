import { Suspense, lazy, useEffect, useRef, type ComponentType, type RefObject } from 'react';
import { Agents } from '../screens/Agents/Agents';
import { Approvals } from '../screens/Approvals/Approvals';
import { Home } from '../screens/Home/Home';
import { Onboarding } from '../screens/Onboarding/Onboarding';
import { Repo } from '../screens/Repo/Repo';
import { Settings } from '../screens/Settings/Settings';
import { Usage } from '../screens/Usage/Usage';
import { useUi } from '../state/hooks';
import type { Screen } from '../state/ui-store';
import s from './Shell.module.css';

/**
 * The two screens that carry Monaco are fetched when they are first shown (discrepancy #116). Everything else
 * is small and static: splitting it would only add round trips. The editor is ~8 MB of the bundle, so this is
 * the difference between painting the shell now and painting it after Monaco has parsed.
 */
const Workspace = lazy(async () => ({ default: (await import('../screens/Workspace/Workspace')).Workspace }));
const Diff = lazy(async () => ({ default: (await import('../screens/Diff/Diff')).Diff }));

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

/**
 * Marks the region ready. Rendered *inside* the boundary, so a screen still being fetched has not claimed to
 * be painted — the visual harness and the e2e specs wait on this attribute.
 */
function Ready({ screen, root }: { screen: Screen; root: RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    // Held in a local: by the time the cleanup runs the ref may already point at the next screen's node.
    const node = root.current;
    node?.setAttribute('data-screen-ready', screen);
    return () => node?.removeAttribute('data-screen-ready');
  }, [screen, root]);
  return null;
}

function Outlet({ screen }: { screen: Screen }) {
  const root = useRef<HTMLDivElement>(null);
  const Component = SCREENS[screen];
  return (
    <div ref={root} className={s['content']} data-screen={screen} data-keyscope={SCOPE_OF[screen]}>
      {/* No fallback: the shell is already drawn and a spinner for a local chunk would only flicker. */}
      <Suspense fallback={null}>
        <Component />
        <Ready screen={screen} root={root} />
      </Suspense>
    </div>
  );
}

export function ScreenOutlet() {
  const screen = useUi((u) => u.screen);
  return <Outlet key={screen} screen={screen} />;
}
