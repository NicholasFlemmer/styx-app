/**
 * `pnpm db:seed [demo|empty|error] [file]` — loads a core fixture into `STYX_DB` (default `.dev/styx.db`).
 * Idempotent; `STYX_FIXTURE_RESET=1` clears domain tables first. Run with tsx.
 */
import { resolve } from 'node:path';
import { fixtures } from '@styx/core';
import { openDatabase } from '../src/main/db/open';
import { Repos } from '../src/main/db/repos';
import { isFixtureName, loadFixture, seed } from '../src/main/db/seed';

const name = process.argv[2] ?? process.env['STYX_FIXTURE'] ?? 'demo';
if (!isFixtureName(name)) {
  process.stderr.write(`unknown fixture "${name}" (demo | empty | error)\n`);
  process.exit(64);
}
const file = resolve(process.argv[3] ?? process.env['STYX_DB'] ?? '.dev/styx.db');
const db = openDatabase(file);
const now = process.env['STYX_NOW'] ? Number(process.env['STYX_NOW']) : fixtures.DEMO_NOW;
const repos = new Repos(db, () => now);
const { seeded } = seed(repos, loadFixture(name), { reset: process.env['STYX_FIXTURE_RESET'] === '1' });
process.stdout.write(
  `${file}: ${seeded ? `seeded ${name}` : 'already populated (set STYX_FIXTURE_RESET=1 to reseed)'}\n`,
);
db.close();
