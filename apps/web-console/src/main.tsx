import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { loadRuntimeConfig } from './runtime-config.ts';
import './styles.css';

const config = await loadRuntimeConfig();
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
}
