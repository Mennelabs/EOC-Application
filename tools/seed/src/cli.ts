/**
 * Usage: pnpm seed [--seed 2026] [--reports 1140] [--out tools/seed/out]
 * Writes the synthetic county as JSON/GeoJSON. Loading into the database
 * arrives with the layer-1 schema (docs/plans/layer-1.md).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildCounty } from './county.ts';

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '2026' },
    reports: { type: 'string', default: '1140' },
    out: { type: 'string', default: resolve(import.meta.dirname, '../out') },
  },
});

const county = buildCounty(Number(values.seed), Number(values.reports));
await mkdir(values.out, { recursive: true });
const files: Record<string, unknown> = {
  'meta.json': county.meta,
  'tenants.json': county.tenants,
  'areas.json': county.areas,
  'parcels.geojson': county.parcels,
  'facilities.json': county.facilities,
  'personnel.json': county.personnel,
  'reports.json': county.reports,
};
for (const [name, data] of Object.entries(files)) {
  await writeFile(join(values.out, name), JSON.stringify(data, null, 1) + '\n');
}
console.log(
  JSON.stringify({
    msg: 'synthetic county written',
    out: values.out,
    tenants: county.tenants.length,
    parcels: county.parcels.features.length,
    reports: county.reports.length,
  }),
);
