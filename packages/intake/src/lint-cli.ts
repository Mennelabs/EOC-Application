/** Prints the reading-grade table and lint findings for the default graph (INT-08 human review). */
import { westwindGraph } from './graphs/westwind.ts';
import { gradeTable, lintGraph } from './lint.ts';

const findings = lintGraph(westwindGraph);
for (const row of gradeTable(westwindGraph)) {
  console.log(`${row.grade.toFixed(1).padStart(5)}  ${row.id.padEnd(22)} ${row.prompt}`);
}
if (findings.length > 0) {
  console.error(`\n${findings.length} finding(s):`);
  for (const f of findings)
    console.error(`- ${f.nodeId} ${f.field} [${f.locale}] ${f.rule}: ${f.detail}`);
  process.exit(1);
}
console.log('\nAll strings pass the intake lint (INT-08, INT-17, INT-18).');
