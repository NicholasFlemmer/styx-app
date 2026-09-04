/** Prints per-state diff ratios from the last `pnpm visual` run (test-results/visual/results.ndjson). */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { VisualRecord } from './screens.spec.ts';

const here = import.meta.dirname;
const RESULTS = join(here, '../test-results/visual/results.ndjson');
const BASELINE_DIR = join(here, '__baseline__');

if (!existsSync(RESULTS)) {
  console.log(`No results at ${RESULTS}. Run \`pnpm visual\` first.`);
  process.exit(0);
}

const records: VisualRecord[] = readFileSync(RESULTS, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as VisualRecord);

const seen = new Set(records.map((r) => r.file));
const baselines = existsSync(BASELINE_DIR) ? readdirSync(BASELINE_DIR).filter((f) => f.endsWith('.png')) : [];
const notRun = baselines.filter((f) => !seen.has(f));

const pct = (r: number | undefined): string => (r === undefined ? '—' : `${(r * 100).toFixed(3)} %`);
const w = Math.max(20, ...records.map((r) => r.file.length));
console.log(`${'baseline'.padEnd(w)}  ${'status'.padEnd(7)}  ${'diff'.padStart(9)}  note`);
for (const r of records.sort((a, b) => a.file.localeCompare(b.file))) {
  console.log(
    `${r.file.padEnd(w)}  ${r.status.padEnd(7)}  ${pct(r.diffRatio).padStart(9)}  ${r.reason ?? ''}`,
  );
}
const count = (s: VisualRecord['status']): number => records.filter((r) => r.status === s).length;
console.log(
  `\n${records.length} compared: ${count('pass')} pass · ${count('fail')} fail · ${count('skip')} skip · ${count('updated')} updated` +
    (notRun.length ? ` · ${notRun.length} baseline(s) not run` : ''),
);
if (count('fail') > 0) process.exitCode = 1;
