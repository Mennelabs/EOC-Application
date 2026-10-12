// ADM-03: the product name is configuration only. Fails if the current
// product name appears as a literal in application source.
import { spawnSync } from 'node:child_process';

const name = process.env.PRODUCT_NAME_LITERAL ?? 'Common Ground';
const res = spawnSync(
  'git',
  ['grep', '-n', '-i', '-F', name, '--', 'apps', 'services', 'packages', ':!**/*.md'],
  { encoding: 'utf8' },
);
// git grep: 0 = matches found, 1 = no matches, >1 = error.
if (res.status === 0) {
  console.error(
    `ADM-03: "${name}" is hardcoded. Read PRODUCT_NAME from configuration:\n${res.stdout}`,
  );
  process.exit(1);
}
if (res.status !== 1) {
  console.error(`product-name check could not run: ${res.stderr}`);
  process.exit(2);
}
console.log('ADM-03 check passed: product name not hardcoded in apps/services/packages');
