import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@styx/ui/styles.css';
import './styles/app.css';
import { AppRoot } from './app/AppRoot';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);
