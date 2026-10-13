// PUB-07: the first load of the public page stays under 300 KB (uncompressed, map chunk and its
// worker excluded: they load only when a visitor asks for the map). Fails the build when the budget is exceeded.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BUDGET = 300 * 1024;
const dist = new URL('../dist/', import.meta.url).pathname;
let total = 0;
const rows = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (
      /\.(html|js|css)$/.test(name) &&
      !/(^|-)map-[\w-]+\.js$|^maplibre-gl-worker-[\w-]+\.js$/.test(name)
    ) {
      total += st.size;
      rows.push([p.slice(dist.length), st.size]);
    }
  }
};
walk(dist);
for (const [file, size] of rows) process.stdout.write(`${String(size).padStart(8)}  ${file}\n`);
process.stdout.write(`${String(total).padStart(8)}  first load (budget ${BUDGET})\n`);
if (total > BUDGET) {
  console.error(`first load ${total} bytes exceeds the ${BUDGET} byte budget (PUB-07)`);
  process.exit(1);
}
