import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The design-system showcase: every token and component on one page, for the eye and for axe. */
export default defineConfig({
  root: 'src/showcase',
  plugins: [react()],
  build: { outDir: '../../dist-showcase', emptyOutDir: true, target: 'es2022', sourcemap: false },
  preview: { port: 4318, strictPort: true },
});
