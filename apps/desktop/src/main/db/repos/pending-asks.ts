import { pendingAskSchema, type PendingAsk } from '@styx/core';
import type { Db } from '../open';
import { asJson, asNum, asStr, placeholders, toJson, type Raw } from './mappers';

const COLS =
  'id, session_id, kind, grant_id, payload_json, state, resolution_json, position, broker_request_id, created_at, resolved_at';

export const pendingAskFromRow = (r: Raw): PendingAsk =>
  pendingAskSchema.parse({
    id: String(r['id']),
    sessionId: String(r['session_id']),
    kind: String(r['kind']),
    grantId: asStr(r['grant_id']),
    payload: asJson<unknown>(r['payload_json'], {}),
    state: String(r['state']),
    resolution: asJson<unknown>(r['resolution_json'], null),
    position: Number(r['position']),
    brokerRequestId: asStr(r['broker_request_id']),
    createdAt: Number(r['created_at']),
    resolvedAt: asNum(r['resolved_at']),
  });

/** `pending_asks` table: the per-session queue; the head (lowest position, open) is the only one surfaced. */
export class PendingAsksRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly allStmt;
  private readonly bySessionStmt;
  private readonly openBySessionStmt;
  private readonly openAllStmt;
  private readonly byGrantStmt;
  private readonly nextPosStmt;
  private readonly delStmt;

  constructor(private readonly db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO pending_asks (${COLS}) VALUES (${placeholders(11)})
       ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, kind = excluded.kind, grant_id = excluded.grant_id, payload_json = excluded.payload_json, state = excluded.state,
         resolution_json = excluded.resolution_json, position = excluded.position, broker_request_id = excluded.broker_request_id, created_at = excluded.created_at, resolved_at = excluded.resolved_at`,
    );
    this.getStmt = db.prepare(`SELECT ${COLS} FROM pending_asks WHERE id = ?`);
    this.allStmt = db.prepare(`SELECT ${COLS} FROM pending_asks ORDER BY created_at ASC, rowid ASC`);
    this.bySessionStmt = db.prepare(
      `SELECT ${COLS} FROM pending_asks WHERE session_id = ? ORDER BY position ASC`,
    );
    this.openBySessionStmt = db.prepare(
      `SELECT ${COLS} FROM pending_asks WHERE session_id = ? AND state = 'open' ORDER BY position ASC`,
    );
    this.openAllStmt = db.prepare(
      `SELECT ${COLS} FROM pending_asks WHERE state = 'open' ORDER BY created_at ASC`,
    );
    this.byGrantStmt = db.prepare(`SELECT ${COLS} FROM pending_asks WHERE grant_id = ?`);
    this.nextPosStmt = db.prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM pending_asks WHERE session_id = ?',
    );
    this.delStmt = db.prepare('DELETE FROM pending_asks WHERE id = ?');
  }

  upsert(a: PendingAsk): void {
    this.upsertStmt.run(
      a.id,
      a.sessionId,
      a.kind,
      a.grantId,
      toJson(a.payload),
      a.state,
      a.resolution === null ? null : toJson(a.resolution),
      a.position,
      a.brokerRequestId,
      a.createdAt,
      a.resolvedAt,
    );
  }

  get(id: string): PendingAsk | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? pendingAskFromRow(r) : null;
  }

  byIds(ids: readonly string[]): PendingAsk[] {
    if (ids.length === 0) return [];
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM pending_asks WHERE id IN (${placeholders(ids.length)})`)
        .all(...ids) as Raw[]
    ).map(pendingAskFromRow);
  }

  all(): PendingAsk[] {
    return (this.allStmt.all() as Raw[]).map(pendingAskFromRow);
  }

  bySession(sessionId: string): PendingAsk[] {
    return (this.bySessionStmt.all(sessionId) as Raw[]).map(pendingAskFromRow);
  }

  openBySession(sessionId: string): PendingAsk[] {
    return (this.openBySessionStmt.all(sessionId) as Raw[]).map(pendingAskFromRow);
  }

  openAll(): PendingAsk[] {
    return (this.openAllStmt.all() as Raw[]).map(pendingAskFromRow);
  }

  byGrant(grantId: string): PendingAsk | null {
    const r = this.byGrantStmt.get(grantId) as Raw | undefined;
    return r ? pendingAskFromRow(r) : null;
  }

  nextPosition(sessionId: string): number {
    return Number((this.nextPosStmt.get(sessionId) as { p: number }).p);
  }

  remove(id: string): void {
    this.delStmt.run(id);
  }
}
