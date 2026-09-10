import { useEffect } from 'react';
import { AuditDrawer } from '../features/audit-drawer/AuditDrawer';
import { GrantSheet } from '../features/grant-sheet/GrantSheet';
import { AddExistingModal } from '../features/modals/AddExistingModal';
import { ConnectModal } from '../features/modals/ConnectModal';
import { DeployModal } from '../features/modals/DeployModal';
import { NewProjectModal } from '../features/modals/NewProjectModal';
import { SpawnModal } from '../features/modals/SpawnModal';
import { Palette } from '../features/palette/Palette';
import { ToastHost } from '../features/toast/ToastHost';
import { isTrapping, type Overlay } from '../overlays/stack';
import { useUi } from '../state/hooks';
import s from './OverlayHost.module.css';

const render = (o: Overlay) => {
  switch (o.kind) {
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
          return <DeployModal key={o.id} id={o.id} targetId={o.targetId} />;
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
      return <AuditDrawer key={o.id} id={o.id} auditId={o.auditId} />;
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
  const global = overlays.filter((o) => o.kind === 'palette' || o.kind === 'modal');

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
