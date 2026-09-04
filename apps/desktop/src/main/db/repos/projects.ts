import { projectSchema, type Project, type ProjectId, type ProjectSettings } from '@styx/core';
import type { Db } from '../open';
import { asJson, asNum, asStr, asTime, placeholders, toJson, toTime, type Raw } from './mappers';

const COLS =
  'id, name, path, initials, rail_order, settings_json, settings_mtime, created_at, last_activity_at, removed_at';

export const projectFromRow = (r: Raw): Project =>
  projectSchema.parse({
    id: String(r['id']),
    name: String(r['name']),
    path: String(r['path']),
    initials: String(r['initials']),
    railOrder: Number(r['rail_order']),
    hasProjectFile: asNum(r['settings_mtime']) !== null,
    createdAt: Number(r['created_at']),
    lastActivityAt: asTime(r['last_activity_at']),
    removedAt: asNum(r['removed_at']),
  });

/** `projects` table. `settings_json` holds the project-level overrides (Partial<ProjectSettings>) reconciled from `.styx/project.json`. */
export class ProjectsRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly allStmt;
  private readonly byIdsPrefix = `SELECT ${COLS} FROM projects WHERE id IN `;
  private readonly delStmt;
  private readonly byPathStmt;
  private readonly settingsStmt;
  private readonly setSettingsStmt;
  private readonly countStmt;

  constructor(private readonly db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO projects (${COLS}) VALUES (${placeholders(10)})
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path, initials = excluded.initials, rail_order = excluded.rail_order,
         settings_mtime = excluded.settings_mtime, created_at = excluded.created_at, last_activity_at = excluded.last_activity_at, removed_at = excluded.removed_at`,
    );
    this.getStmt = db.prepare(`SELECT ${COLS} FROM projects WHERE id = ?`);
    this.allStmt = db.prepare(`SELECT ${COLS} FROM projects ORDER BY rail_order ASC, created_at ASC`);
    this.delStmt = db.prepare('DELETE FROM projects WHERE id = ?');
    this.byPathStmt = db.prepare(`SELECT ${COLS} FROM projects WHERE path = ?`);
    this.settingsStmt = db.prepare('SELECT settings_json FROM projects WHERE id = ?');
    this.setSettingsStmt = db.prepare(
      'UPDATE projects SET settings_json = ?, settings_mtime = ? WHERE id = ?',
    );
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM projects');
  }

  /** Inserts or updates the entity columns; `settings_json` is only written on insert (see `setSettings`). */
  upsert(p: Project, settings: Partial<ProjectSettings> = {}): void {
    this.upsertStmt.run(
      p.id,
      p.name,
      p.path,
      p.initials,
      p.railOrder,
      toJson(settings),
      p.hasProjectFile ? p.createdAt || 1 : null,
      p.createdAt,
      toTime(p.lastActivityAt),
      p.removedAt,
    );
  }

  get(id: string): Project | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? projectFromRow(r) : null;
  }

  byPath(path: string): Project | null {
    const r = this.byPathStmt.get(path) as Raw | undefined;
    return r ? projectFromRow(r) : null;
  }

  byIds(ids: readonly string[]): Project[] {
    if (ids.length === 0) return [];
    return (this.db.prepare(this.byIdsPrefix + `(${placeholders(ids.length)})`).all(...ids) as Raw[]).map(
      projectFromRow,
    );
  }

  all(): Project[] {
    return (this.allStmt.all() as Raw[]).map(projectFromRow);
  }

  remove(id: string): void {
    this.delStmt.run(id);
  }

  count(): number {
    return Number((this.countStmt.get() as { n: number }).n);
  }

  settings(id: ProjectId | string): Partial<ProjectSettings> {
    const r = this.settingsStmt.get(id) as { settings_json: string } | undefined;
    return r ? asJson<Partial<ProjectSettings>>(r.settings_json, {}) : {};
  }

  setSettings(id: string, settings: Partial<ProjectSettings>, mtime: number | null): void {
    this.setSettingsStmt.run(toJson(settings), mtime, id);
  }

  settingsMtime(id: string): number | null {
    const r = this.db.prepare('SELECT settings_mtime FROM projects WHERE id = ?').get(id) as
      { settings_mtime: number | null } | undefined;
    return r ? asNum(r.settings_mtime) : null;
  }

  static label(r: Raw): string | null {
    return asStr(r['name']);
  }
}
