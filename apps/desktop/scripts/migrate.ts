/**
 * `pnpm db:migrate [file]` — applies pending migrations to `STYX_DB` (default `.dev/styx.db`). Run with tsx.
 */
import { resolve } from 'node:path';
import { openDatabase } from '../src/main/db/open';
import { listMigrations } from '../src/main/db/migrate';

const file = resolve(process.argv[2] ?? process.env['STYX_DB'] ?? '.dev/styx.db');
const db = openDatabase(file);
const version = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string })
  .value;
process.stdout.write(`${file}: schema version ${version} (${listMigrations().length} migrations known)\n`);
db.close();
