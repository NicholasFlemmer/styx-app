import { auditEntrySchema, type AuditEntry } from '@styx/core';
import type { Db } from '../open';
import { asJson, asStr, placeholders, type Raw } from './mappers';

const COLS = `id, seq, time, actor_kind, actor_label, action, project_id, target_id, session_id, worktree_id, grant_id, policy_id, target_label, session_label, worktree_label,
  agent, scope_json, duration, triggered_by, detail_json, prev_hash, hash`;

export const auditFromRow = (r: Raw): AuditEntry =>
  auditEntrySchema.parse({
    id: String(r['id']),
    seq: Number(r['seq']),
    time: Number(r['time']),
    actorKind: String(r['actor_kind']),
    actorLabel: String(r['actor_label']),
    action: String(r['action']),
    projectId: asStr(r['project_id']),
    targetId: asStr(r['target_id']),
    sessionId: asStr(r['session_id']),
    worktreeId: asStr(r['worktree_id']),
    grantId: asStr(r['grant_id']),
    policyId: asStr(r['policy_id']),
    targetLabel: asStr(r['target_label']),
    sessionLabel: asStr(r['session_label']),
    worktreeLabel: asStr(r['worktree_label']),
    agent: asStr(r['agent']),
    scope: asJson<string[] | null>(r['scope_json'], null),
    duration: asStr(r['duration']),
    triggeredBy: r['triggered_by'] === '' ? null : asStr(r['triggered_by']),
    detail: asJson<Record<string, unknown>>(r['detail_json'], {}),
    prevHash: r['prev_hash'] === '' ? null : asStr(r['prev_hash']),
    hash: String(r['hash']),
  });

/** Read-only view over `audit_entries`; writes go through `AuditService.append` only. */
export class AuditRepo {
  private readonly getStmt;
  private readonly recentStmt;
  private readonly allStmt;

  constructor(private readonly db: Db) {
    this.getStmt = db.prepare(`SELECT ${COLS} FROM audit_entries WHERE id = ?`);
    this.recentStmt = db.prepare(
      `SELECT ${COLS} FROM (SELECT ${COLS} FROM audit_entries ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`,
    );
    this.allStmt = db.prepare(`SELECT ${COLS} FROM audit_entries ORDER BY seq ASC`);
  }

  get(id: string): AuditEntry | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? auditFromRow(r) : null;
  }

  byIds(ids: readonly string[]): AuditEntry[] {
    if (ids.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT ${COLS} FROM audit_entries WHERE id IN (${placeholders(ids.length)}) ORDER BY seq ASC`,
        )
        .all(...ids) as Raw[]
    ).map(auditFromRow);
  }

  /** Most recent `limit` entries, oldest first (the snapshot carries the recent window; older pages via `audit.list`). */
  recent(limit = 500): AuditEntry[] {
    return (this.recentStmt.all(limit) as Raw[]).map(auditFromRow);
  }

  all(): AuditEntry[] {
    return (this.allStmt.all() as Raw[]).map(auditFromRow);
  }

  list(opts: {
    beforeSeq?: number | null;
    limit: number;
    targetId?: string;
    sessionId?: string;
  }): AuditEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.beforeSeq !== undefined && opts.beforeSeq !== null) {
      where.push('seq < ?');
      params.push(opts.beforeSeq);
    }
    if (opts.targetId) {
      where.push('target_id = ?');
      params.push(opts.targetId);
    }
    if (opts.sessionId) {
      where.push('session_id = ?');
      params.push(opts.sessionId);
    }
    params.push(opts.limit);
    const sql = `SELECT ${COLS} FROM audit_entries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params) as Raw[]).map(auditFromRow);
  }
}
