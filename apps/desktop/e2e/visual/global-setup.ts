import { rmSync } from 'node:fs';
import { join } from 'node:path';

/** Clears the last run's visual results once per run (Playwright restarts workers after failures, so beforeAll is not once). */
export default function globalSetup(): void {
  rmSync(join(__dirname, '../test-results/visual/results.ndjson'), { force: true });
}
