import { grantSchema, grantUseSchema, type Grant, type GrantUse, type Scope } from '@styx/core';
import type { Db } from '../open';
import { asBool, asJson, asNum, asStr, placeholders, toBit, toJson, type Raw } from './mappers';

const COLS = `id, session_id, target_id, worktree_id, scope_json, scope_mask, duration, reason, state, requested_at, issued_at, expires_at, last_used_at, idle_expires_at,
  revoked_at, revoke_reason, policy_id, mfa_verified, decided_by`;

const SCOPE_BIT: Record<Scope, number> = { read: 1, write: 2, deploy: 4, delete: 8 };
export const scopeMask = (scope: readonly Scope[]): number => scope.reduce((m, s) => m | SCOPE_BIT[s], 0);

export const grantFromRow = (r: Raw): Grant =>
  grantSchema.parse({
    id: String(r['id']),
    sessionId: asStr(r['session_id']),
    targetId: String(r['target_id']),
    worktreeId: asStr(r['worktree_id']),
    scope: asJson<string[]>(r['scope_json'], []),
    duration: String(r['duration']),
    reason: String(r['reason']),
    state: String(r['state']),
    requestedAt: Number(r['requested_at']),
    issuedAt: asNum(r['issued_at']),
    expiresAt: asNum(r['expires_at']),
    lastUsedAt: asNum(r['last_used_at']),
    idleExpiresAt: asNum(r['idle_expires_at']),
    revokedAt: asNum(r['revoked_at']),
    revokeReason: asStr(r['revoke_reason']),
    policyId: asStr(r['policy_id']),
    mfaVerified: asBool(r['mfa_verified']),
    decidedBy: asStr(r['decided_by']),
  });

/** `grants` table. (`cred_nonce` is a legacy column kept for migration compatibility; it is never read or written.) */
export class GrantsRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly allStmt;
  private readonly bySessionStmt;
  private readonly byTargetStmt;
  private readonly activeStmt;
  private readonly delStmt;

  constructor(private readonly db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO grants (${COLS}) VALUES (${placeholders(19)})
       ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, target_id = excluded.target_id, worktree_id = excluded.worktree_id, scope_json = excluded.scope_json,
         scope_mask = excluded.scope_mask, duration = excluded.duration, reason = excluded.reason, state = excluded.state, requested_at = excluded.requested_at,
         issued_at = excluded.issued_at, expires_at = excluded.expires_at, last_used_at = excluded.last_used_at, idle_expires_at = excluded.idle_expires_at,
         revoked_at = excluded.revoked_at, revoke_reason = excluded.revoke_reason, policy_id = excluded.policy_id, mfa_verified = excluded.mfa_verified, decided_by = excluded.decided_by`,
    );
    this.getStmt = db.prepare(`SELECT ${COLS} FROM grants WHERE id = ?`);
    this.allStmt = db.prepare(`SELECT ${COLS} FROM grants ORDER BY requested_at ASC, rowid ASC`);
    this.bySessionStmt = db.prepare(
      `SELECT ${COLS} FROM grants WHERE session_id = ? ORDER BY requested_at ASC`,
    );
    this.byTargetStmt = db.prepare(
      `SELECT ${COLS} FROM grants WHERE target_id = ? ORDER BY requested_at ASC`,
    );
    this.activeStmt = db.prepare(
      `SELECT ${COLS} FROM grants WHERE state = 'active' ORDER BY requested_at ASC`,
    );
    this.delStmt = db.prepare('DELETE FROM grants WHERE id = ?');
  }

  upsert(g: Grant): void {
    this.upsertStmt.run(
      g.id,
      g.sessionId,
      g.targetId,
      g.worktreeId,
      toJson(g.scope),
      scopeMask(g.scope),
      g.duration,
      g.reason,
      g.state,
      g.requestedAt,
      g.issuedAt,
      g.expiresAt,
      g.lastUsedAt,
      g.idleExpiresAt,
      g.revokedAt,
      g.revokeReason,
      g.policyId,
      toBit(g.mfaVerified),
      g.decidedBy,
    );
  }

  get(id: string): Grant | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? grantFromRow(r) : null;
  }

  byIds(ids: readonly string[]): Grant[] {
    if (ids.length === 0) return [];
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM grants WHERE id IN (${placeholders(ids.length)})`)
        .all(...ids) as Raw[]
    ).map(grantFromRow);
  }

  all(): Grant[] {
    return (this.allStmt.all() as Raw[]).map(grantFromRow);
  }

  bySession(sessionId: string): Grant[] {
    return (this.bySessionStmt.all(sessionId) as Raw[]).map(grantFromRow);
  }

  byTarget(targetId: string): Grant[] {
    return (this.byTargetStmt.all(targetId) as Raw[]).map(grantFromRow);
  }

  active(): Grant[] {
    return (this.activeStmt.all() as Raw[]).map(grantFromRow);
  }

  remove(id: string): void {
    this.delStmt.run(id);
  }
}

const USE_COLS = 'id, grant_id, session_id, via, command, scope_used, exit_code, started_at, ended_at';

export const grantUseFromRow = (r: Raw): GrantUse =>
  grantUseSchema.parse({
    id: String(r['id']),
    grantId: String(r['grant_id']),
    sessionId: asStr(r['session_id']),
    via: String(r['via']),
    command: asStr(r['command']),
    scopeUsed: String(r['scope_used'] ?? 'read'),
    exitCode: asNum(r['exit_code']),
    startedAt: Number(r['started_at']),
    endedAt: asNum(r['ended_at']),
  });

/** `grant_uses` table: one row per shim exec / credential fetch / ssh sign. */
export class GrantUsesRepo {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly endStmt;
  private readonly byGrantStmt;

  constructor(db: Db) {
    this.insertStmt = db.prepare(`INSERT INTO grant_uses (${USE_COLS}) VALUES (${placeholders(9)})`);
    this.getStmt = db.prepare(`SELECT ${USE_COLS} FROM grant_uses WHERE id = ?`);
    this.endStmt = db.prepare('UPDATE grant_uses SET exit_code = ?, ended_at = ? WHERE id = ?');
    this.byGrantStmt = db.prepare(
      `SELECT ${USE_COLS} FROM grant_uses WHERE grant_id = ? ORDER BY started_at ASC`,
    );
  }

  insert(u: GrantUse): void {
    this.insertStmt.run(
      u.id,
      u.grantId,
      u.sessionId,
      u.via,
      u.command,
      u.scopeUsed,
      u.exitCode,
      u.startedAt,
      u.endedAt,
    );
  }

  get(id: string): GrantUse | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? grantUseFromRow(r) : null;
  }

  end(id: string, exitCode: number, endedAt: number): void {
    this.endStmt.run(exitCode, endedAt, id);
  }

  byGrant(grantId: string): GrantUse[] {
    return (this.byGrantStmt.all(grantId) as Raw[]).map(grantUseFromRow);
  }
}
