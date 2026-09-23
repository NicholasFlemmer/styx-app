import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import '@styx/ui/styles.css';
import './styles/app.css';
import { windowKind } from './state/bridge';

/**
 * One bundle serves three windows, so each root is fetched rather than imported (discrepancy #116). A pop-out
 * chat and the agent dock have no editor and no workspace; statically importing `AppRoot` made them parse
 * Monaco and the whole screen set before showing a transcript.
 */
const kind = windowKind();
const Root = lazy(async () => {
  if (kind === 'popout') return { default: (await import('./app/PopoutRoot')).PopoutRoot };
  if (kind === 'dock') return { default: (await import('./app/DockRoot')).DockRoot };
  return { default: (await import('./app/AppRoot')).AppRoot };
});

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    {/* No fallback: the window is already the app's background colour, and a flash of chrome would be worse. */}
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
);
