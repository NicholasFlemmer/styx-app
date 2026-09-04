import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@styx/ui/styles.css';
import './styles/app.css';
import { AppRoot } from './app/AppRoot';
import { PopoutRoot } from './app/PopoutRoot';
import { windowKind } from './state/bridge';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
const Root = windowKind() === 'popout' ? PopoutRoot : AppRoot;
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
