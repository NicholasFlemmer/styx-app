import { taskResultSchema, type TaskResult } from '@styx/core';
import type { Db } from '../open';
import { asJson, type Raw } from './mappers';

const COLS = 'session_id, project_id, kind, body_json, launch_approved_at, launch_picked_json, updated_at';

/** A row back to a result; a row that no longer parses (an older shape) is dropped rather than shown wrong. */
export const taskResultFromRow = (r: Raw): TaskResult | null => {
  const parsed = taskResultSchema.safeParse({
    id: String(r['session_id']),
    projectId: String(r['project_id']),
    body: asJson<unknown>(r['body_json'], null),
    launchApprovedAt: r['launch_approved_at'] === null ? null : Number(r['launch_approved_at']),
    launchPicked: asJson<unknown>(r['launch_picked_json'], []),
    updatedAt: Number(r['updated_at']),
  });
  return parsed.success ? parsed.data : null;
};

/** `task_results` (0026): one campaign or report per task (ADR-0033). */
export class TaskResultsRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly allStmt;
  private readonly approveStmt;

  constructor(db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO task_results (${COLS}) VALUES (?, ?, ?, ?, NULL, '[]', ?)
       ON CONFLICT(session_id) DO UPDATE SET kind = excluded.kind, body_json = excluded.body_json,
         launch_approved_at = NULL, launch_picked_json = '[]', updated_at = excluded.updated_at`,
    );
    this.getStmt = db.prepare(`SELECT ${COLS} FROM task_results WHERE session_id = ?`);
    this.allStmt = db.prepare(`SELECT ${COLS} FROM task_results ORDER BY updated_at DESC LIMIT 500`);
    // Only the result the person saw, and only once.
    this.approveStmt = db.prepare(
      'UPDATE task_results SET launch_approved_at = ?, launch_picked_json = ? WHERE session_id = ? AND updated_at = ? AND launch_approved_at IS NULL',
    );
  }

  /** A new result replaces the old one, and with it any approval of the old launch plan. */
  put(r: Omit<TaskResult, 'launchApprovedAt' | 'launchPicked'>): void {
    this.upsertStmt.run(r.id, r.projectId, r.body.kind, JSON.stringify(r.body), r.updatedAt);
  }

  get(sessionId: string): TaskResult | null {
    const r = this.getStmt.get(sessionId) as Raw | undefined;
    return r ? taskResultFromRow(r) : null;
  }

  all(): TaskResult[] {
    return (this.allStmt.all() as Raw[]).map(taskResultFromRow).filter((x): x is TaskResult => x !== null);
  }

  /** False when the result changed since `seenAt`, or was already approved. */
  approveLaunch(sessionId: string, at: number, seenAt: number, picked: number[]): boolean {
    return this.approveStmt.run(at, JSON.stringify(picked), sessionId, seenAt).changes === 1;
  }
}
