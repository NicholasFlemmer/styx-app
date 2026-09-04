import type BetterSqlite3 from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Migrations are bundled as raw strings (vite `import.meta.glob`) so they work inside the asar. Outside vite
 * (scripts run with tsx) `import.meta.glob` is undefined and the files are read from disk instead.
 */
function bundled(): Record<string, string> | null {
  try {
    return import.meta.glob('./migrations/*.sql', { query: '?raw', eager: true, import: 'default' }) as Record<string, string>;
  } catch {
    return null; // not running under vite (tsx scripts): import.meta.glob is undefined
  }
}

function fromDisk(): Record<string, string> {
  const dir = join(__dirname, 'migrations');
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (f.endsWith('.sql')) out[`./migrations/${f}`] = readFileSync(join(dir, f), 'utf8');
  return out;
}

export interface MigrationResult {
  applied: string[];
  version: number;
}

export function listMigrations(): { name: string; sql: string }[] {
  const files = bundled() ?? fromDisk();
  return Object.entries(files)
    .map(([path, sql]) => ({ name: path.replace(/^.*\//, '').replace(/\.sql$/, ''), sql }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Applies pending migrations in one transaction. Refuses to open a DB newer than this build knows. */
export function migrate(db: BetterSqlite3.Database, migrations = listMigrations()): MigrationResult {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  const current = row ? Number(row.value) : 0;
  if (current > migrations.length) {
    throw new Error(`Database schema version ${current} is newer than this build supports (${migrations.length}). Downgrade is not supported.`);
  }
  const pending = migrations.slice(current);
  const applied: string[] = [];
  const run = db.transaction(() => {
    for (const m of pending) {
      db.exec(m.sql);
      applied.push(m.name);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(migrations.length));
  });
  run();
  return { applied, version: migrations.length };
}
