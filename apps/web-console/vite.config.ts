import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served under /console/ by the gateway.
export default defineConfig({
  plugins: [react()],
  base: '/console/',
  build: { target: 'es2022', sourcemap: false },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/auth': 'http://localhost:8081',
      '/config.json': 'http://localhost:8081',
    },
  },
});
