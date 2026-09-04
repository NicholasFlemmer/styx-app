import { repoSchema, type Repo } from '@styx/core';
import type { Db } from '../open';
import { asBool, asJson, asNum, placeholders, toBit, toJson, type Raw } from './mappers';

const COLS =
  'id, project_id, default_branch, remotes_json, ahead, behind, fetched_at, line_endings, long_paths';

export const repoFromRow = (r: Raw): Repo =>
  repoSchema.parse({
    id: String(r['id']),
    projectId: String(r['project_id']),
    defaultBranch: String(r['default_branch']),
    remotes: asJson<unknown[]>(r['remotes_json'], []),
    ahead: Number(r['ahead']),
    behind: Number(r['behind']),
    fetchedAt: asNum(r['fetched_at']),
    lineEndings: String(r['line_endings']),
    longPaths: asBool(r['long_paths']),
  });

/** `repos` table (one git repo per project). */
export class GitReposRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly allStmt;
  private readonly byProjectStmt;
  private readonly delStmt;

  constructor(private readonly db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO repos (${COLS}) VALUES (${placeholders(9)})
       ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, default_branch = excluded.default_branch, remotes_json = excluded.remotes_json,
         ahead = excluded.ahead, behind = excluded.behind, fetched_at = excluded.fetched_at, line_endings = excluded.line_endings, long_paths = excluded.long_paths`,
    );
    this.getStmt = db.prepare(`SELECT ${COLS} FROM repos WHERE id = ?`);
    this.allStmt = db.prepare(`SELECT ${COLS} FROM repos ORDER BY rowid`);
    this.byProjectStmt = db.prepare(`SELECT ${COLS} FROM repos WHERE project_id = ?`);
    this.delStmt = db.prepare('DELETE FROM repos WHERE id = ?');
  }

  upsert(r: Repo): void {
    this.upsertStmt.run(
      r.id,
      r.projectId,
      r.defaultBranch,
      toJson(r.remotes),
      r.ahead,
      r.behind,
      r.fetchedAt,
      r.lineEndings,
      toBit(r.longPaths),
    );
  }

  get(id: string): Repo | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? repoFromRow(r) : null;
  }

  byProject(projectId: string): Repo | null {
    const r = this.byProjectStmt.get(projectId) as Raw | undefined;
    return r ? repoFromRow(r) : null;
  }

  byIds(ids: readonly string[]): Repo[] {
    if (ids.length === 0) return [];
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM repos WHERE id IN (${placeholders(ids.length)})`)
        .all(...ids) as Raw[]
    ).map(repoFromRow);
  }

  all(): Repo[] {
    return (this.allStmt.all() as Raw[]).map(repoFromRow);
  }

  remove(id: string): void {
    this.delStmt.run(id);
  }
}
