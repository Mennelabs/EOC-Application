// FLD-13: MapLibre GL JS 6 runs its worker from separate module files. The web build ships them
// beside the app (public/maplibre/, copied into the export), and the area map points MapLibre at
// them; nothing is fetched from elsewhere (CSP: script-src 'self').
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('maplibre-gl/package.json'));
const out = join(here, '..', 'public', 'maplibre');
mkdirSync(out, { recursive: true });
for (const f of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'])
  copyFileSync(join(dist, 'dist', f), join(out, f));
