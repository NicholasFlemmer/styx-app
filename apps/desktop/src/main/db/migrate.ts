import type BetterSqlite3 from 'better-sqlite3';

/** Migrations are bundled as raw strings so they work inside the asar. Keep names sortable (NNNN_name.sql). */
const files = import.meta.glob('./migrations/*.sql', { query: '?raw', eager: true, import: 'default' }) as Record<string, string>;

export interface MigrationResult {
  applied: string[];
  version: number;
}

export function listMigrations(): { name: string; sql: string }[] {
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
