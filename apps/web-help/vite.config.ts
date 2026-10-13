import { defineConfig } from 'vite';

// The public "Find help" page (PUB-07): served under /help/* by the gateway,
// opened at /<county>/help. No framework: the first load must stay under
// 300 KB; the map library loads only when a visitor asks for the map.
export default defineConfig({
  base: '/help/',
  // map.ts is imported on demand, so the map library lands in its own chunk by itself.
  build: { target: 'es2022', sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:8080', '/config.json': 'http://localhost:8081' } },
});
