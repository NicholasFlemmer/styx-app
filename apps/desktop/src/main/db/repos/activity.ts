import { activityRowSchema, type ActivityRow } from '@styx/core';
import type { Db } from '../open';
import { asStr, placeholders, type Raw } from './mappers';

const COLS = 'id, at, who, what, project_id, session_id';

export const activityFromRow = (r: Raw): ActivityRow =>
  activityRowSchema.parse({
    id: String(r['id']),
    at: Number(r['at']),
    who: String(r['who']),
    what: String(r['what']),
    projectId: asStr(r['project_id']),
    sessionId: asStr(r['session_id']),
  });

/** `activity` table: the Home feed, newest first. */
export class ActivityRepo {
  private readonly insertStmt;
  private readonly recentStmt;
  private readonly countStmt;

  constructor(db: Db) {
    this.insertStmt = db.prepare(`INSERT OR IGNORE INTO activity (${COLS}) VALUES (${placeholders(6)})`);
    this.recentStmt = db.prepare(`SELECT ${COLS} FROM activity ORDER BY at DESC, rowid DESC LIMIT ?`);
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM activity');
  }

  insert(row: ActivityRow): void {
    this.insertStmt.run(row.id, row.at, row.who, row.what, row.projectId, row.sessionId);
  }

  recent(limit = 100): ActivityRow[] {
    return (this.recentStmt.all(limit) as Raw[]).map(activityFromRow);
  }

  count(): number {
    return Number((this.countStmt.get() as { n: number }).n);
  }
}
