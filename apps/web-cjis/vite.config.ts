import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The CJIS enclave's own web app (ADR-0038), served at the root of the
// enclave gateway's origin, never by the platform.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { target: 'es2022', sourcemap: false },
  server: {
    port: 5174,
    proxy: {
      '/api': 'https://localhost:8443',
      '/auth': 'https://localhost:8443',
    },
  },
});
