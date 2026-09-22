import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { migrate } from './migrate';

export type Db = Database.Database;

/** Opens (or creates) the app database, backing it up before applying migrations. `:memory:` for tests. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) backup(file);
  }
  const db = new Database(file);
  migrate(db);
  return db;
}

function backup(file: string): void {
  const dir = dirname(file);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(file, join(dir, `styx.db.bak-${stamp}`));
  const baks = readdirSync(dir)
    .filter((f) => f.startsWith('styx.db.bak-'))
    .sort();
  for (const old of baks.slice(0, Math.max(0, baks.length - 3))) unlinkSync(join(dir, old));
}
