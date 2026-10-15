import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initPreferences } from '@cg/ui';
import { loadRuntimeConfig } from './runtime-config.ts';
import '@cg/ui/fonts/staff.css';
import '@cg/ui/styles.css';
import './styles.css';

// The device's theme and density before the first paint (ADR-0045).
initPreferences();

const config = await loadRuntimeConfig();
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
}
