/**
 * Live smoke test of the connectors against the real federal services
 * (ADR-0039). A manual command, never run in CI, and it writes nothing:
 * it prints, per dataset, how many rows came back, the vintage, and which
 * fields were filled, never a value, so its output is safe to paste into a
 * status note (SCL-12: no real data enters the repository).
 *
 *   pnpm --filter @cg/refdata smoke -- --state 29 --county 29189 --name "St. Louis County"
 *   ... --dataset tract_profile     (one dataset)
 *
 * The hosts must be reachable (this build environment's network policy
 * blocks them); CENSUS_API_KEY and REFDATA_CONTACT are read if set.
 */
import { parseArgs } from 'node:util';
import { checkRow, type Dataset } from './datasets.ts';
import { createEgressHttp } from './http.ts';
import { connectors } from './registry.ts';
import { countyNameKey } from './states.ts';

const { values } = parseArgs({
  options: {
    state: { type: 'string' },
    county: { type: 'string', multiple: true },
    name: { type: 'string', multiple: true },
    bbox: { type: 'string' },
    dataset: { type: 'string' },
  },
});
if (!values.state || !values.county?.length) {
  console.error(
    'usage: smoke --state 29 --county 29189 [--name "St. Louis County"] [--bbox w,s,e,n] [--dataset tract]',
  );
  process.exit(2);
}
const bbox = values.bbox?.split(',').map(Number);
const scope = {
  stateFips: values.state,
  countyFips: values.county,
  ...(values.name?.length ? { countyNames: values.name.map(countyNameKey) } : {}),
  ...(bbox?.length === 4 && bbox.every(Number.isFinite)
    ? { bbox: bbox as [number, number, number, number] }
    : {}),
};
const key = process.env['CENSUS_API_KEY'];
/** The command's report goes to the terminal only. */
const say = (line: string) => process.stdout.write(`${line}\n`);
const contact = process.env['REFDATA_CONTACT'];

for (const c of connectors) {
  if (values.dataset && c.dataset !== values.dataset) continue;
  const started = Date.now();
  try {
    const http = createEgressHttp({
      allowedHosts: c.hosts,
      userAgent: `reference data smoke test${contact ? ` (${contact})` : ''}`,
    });
    const r = await c.fetch({
      http,
      scope,
      secrets: key ? { censusApiKey: key } : {},
      now: () => new Date(),
    });
    let rows = 0;
    let bad = 0;
    const filled = new Set<string>();
    for await (const raw of r.rows) {
      rows++;
      const checked = checkRow(c.dataset as Dataset, raw);
      if (!checked.ok) bad++;
      for (const [k, v] of Object.entries(raw)) if (v !== null && v !== undefined) filled.add(k);
    }
    say(
      `${c.id}: ${rows} rows (${bad} failing checks), vintage ${r.vintage ?? 'n/a'}, ${Date.now() - started} ms; fields filled: ${[...filled].sort().join(', ')}`,
    );
  } catch (err) {
    say(
      `${c.id}: FAILED after ${Date.now() - started} ms: ${(err as Error).name}: ${(err as Error).message}`,
    );
  }
}
