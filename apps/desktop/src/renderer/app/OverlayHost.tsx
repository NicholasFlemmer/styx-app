import { TaskDialog } from '../features/tasks/TaskDialog';
import { useEffect } from 'react';
import { AuditDrawer } from '../features/audit-drawer/AuditDrawer';
import { GrantSheet } from '../features/grant-sheet/GrantSheet';
import { AddExistingModal } from '../features/modals/AddExistingModal';
import { ConnectAgentModal } from '../features/modals/ConnectAgentModal';
import { ConnectModal } from '../features/modals/ConnectModal';
import { DeployModal } from '../features/modals/DeployModal';
import { DeploySetupModal } from '../features/modals/DeploySetupModal';
import { ConnectRepoModal } from '../features/modals/ConnectRepoModal';
import { NewProjectModal } from '../features/modals/NewProjectModal';
import { LandModal } from '../features/modals/LandModal';
import { PublishModal } from '../features/modals/PublishModal';
import { PolicyRuleModal } from '../features/modals/PolicyRuleModal';
import { SignInModal } from '../features/modals/SignInModal';
import { SpawnModal } from '../features/modals/SpawnModal';
import { Palette } from '../features/palette/Palette';
import { SkillDrawer } from '../features/skills/SkillDrawer';
import { ToastHost } from '../features/toast/ToastHost';
import { isTrapping, type Overlay } from '../overlays/stack';
import { useUi } from '../state/hooks';
import s from './OverlayHost.module.css';

const render = (o: Overlay) => {
  switch (o.kind) {
    case 'task':
      return <TaskDialog key={o.id} id={o.id} selectedKey={o.taskKey} />;
    case 'palette':
      return <Palette key={o.id} id={o.id} />;
    case 'modal':
      switch (o.modal) {
        case 'spawn':
          return <SpawnModal key={o.id} id={o.id} projectId={o.projectId} />;
        case 'new-project':
          return <NewProjectModal key={o.id} id={o.id} {...(o.mode !== undefined ? { mode: o.mode } : {})} />;
        case 'add-existing':
          return <AddExistingModal key={o.id} id={o.id} />;
        case 'deploy':
          return (
            <DeployModal
              key={o.id}
              id={o.id}
              targetId={o.targetId}
              {...(o.deployId !== undefined ? { deployId: o.deployId } : {})}
            />
          );
        case 'deploy-setup':
          return <DeploySetupModal key={o.id} id={o.id} projectId={o.projectId} />;
        case 'connect-repo':
          return (
            <ConnectRepoModal
              key={o.id}
              id={o.id}
              projectId={o.projectId}
              {...(o.returnTo !== undefined ? { returnTo: o.returnTo } : {})}
            />
          );
        case 'publish':
          return <PublishModal key={o.id} id={o.id} worktreeId={o.worktreeId} />;
        case 'sign-in':
          return (
            <SignInModal key={o.id} id={o.id} {...(o.reason !== undefined ? { reason: o.reason } : {})} />
          );
        case 'policy-rule':
          return (
            <PolicyRuleModal
              key={o.id}
              id={o.id}
              {...(o.policyId !== undefined ? { policyId: o.policyId } : {})}
            />
          );
        case 'land':
          return <LandModal key={o.id} id={o.id} worktreeId={o.worktreeId} />;
        case 'connect-agent':
          return (
            <ConnectAgentModal
              key={o.id}
              id={o.id}
              agent={o.agent}
              {...(o.returnTo !== undefined ? { returnTo: o.returnTo } : {})}
            />
          );
        case 'connect':
          return (
            <ConnectModal
              key={o.id}
              id={o.id}
              projectId={o.projectId}
              {...(o.provider !== undefined ? { provider: o.provider } : {})}
              {...(o.targetId !== undefined ? { targetId: o.targetId } : {})}
            />
          );
      }
      return null;
    case 'sheet':
      return <GrantSheet key={o.id} id={o.id} sessionId={o.sessionId} askId={o.askId} />;
    case 'drawer':
      switch (o.drawer) {
        case 'audit':
          return <AuditDrawer key={o.id} id={o.id} auditId={o.auditId} />;
        case 'skill':
          return <SkillDrawer key={o.id} id={o.id} directory={o.directory} />;
      }
      return null;
    case 'toast':
      return null;
  }
};

/**
 * Renders the overlay stack as a sibling of `#layer-app` (plan §8 Overlays). Sheets and drawers sit in the
 * content region; palette and modals cover the window; toasts are hosted by `ToastHost`. While any trapping
 * overlay is open `#layer-app` is inert.
 */
export function OverlayHost() {
  const overlays = useUi((u) => u.overlays);
  const screen = useUi((u) => u.screen);
  const trapping = isTrapping(overlays);

  useEffect(() => {
    const app = document.getElementById('layer-app');
    if (app === null) return;
    if (trapping) app.setAttribute('inert', '');
    else app.removeAttribute('inert');
    return () => app.removeAttribute('inert');
  }, [trapping]);

  const regional = overlays.filter((o) => o.kind === 'sheet' || o.kind === 'drawer');
  const global = overlays.filter((o) => o.kind === 'palette' || o.kind === 'modal' || o.kind === 'task');

  return (
    <div
      id="layer-overlay"
      className={s['host']}
      data-keyscope="overlay"
      data-trapping={trapping ? 'true' : undefined}
    >
      <div className={s['region']} data-chrome-hidden={screen === 'onboarding' ? 'true' : undefined}>
        {regional.map(render)}
      </div>
      <div className={s['global']}>{global.map(render)}</div>
      <ToastHost />
    </div>
  );
}
