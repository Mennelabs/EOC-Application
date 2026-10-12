import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served at the site root by the gateway. The API and runtime config come from
// the same origin, so no environment-specific URLs are baked into the build.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { target: 'es2022', sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:8080', '/config.json': 'http://localhost:8081' } },
});
