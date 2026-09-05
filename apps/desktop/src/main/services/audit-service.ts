import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Db } from '../db/open';
import { redact } from './logger';

export type AuditActorKind = 'you' | 'system' | 'agent';
export type AuditAction =
  | 'requested' | 'granted' | 'denied' | 'used' | 'revoked' | 'expired'
  | 'opened-pr' | 'merged-pr' | 'connected' | 'disconnected' | 'tested' | 'policy-changed' | 'exported';

export interface AuditInput {
  time?: number;
  actorKind: AuditActorKind;
  actorLabel: string;
  action: AuditAction;
  projectId?: string | null;
  targetId?: string | null;
  sessionId?: string | null;
  worktreeId?: string | null;
  grantId?: string | null;
  policyId?: string | null;
  targetLabel?: string | null;
  sessionLabel?: string | null;
  worktreeLabel?: string | null;
  agent?: string | null;
  scope?: string[] | null;
  duration?: string | null;
  triggeredBy: string;
  detail?: Record<string, unknown> | null;
}

export interface AuditRow extends Omit<AuditInput, 'scope' | 'detail' | 'time'> {
  id: string;
  seq: number;
  time: number;
  scopeJson: string | null;
  detailJson: string | null;
  prevHash: string;
  hash: string;
}

const COLS = [
  'id', 'seq', 'time', 'actor_kind', 'actor_label', 'action', 'project_id', 'target_id', 'session_id', 'worktree_id', 'grant_id', 'policy_id',
  'target_label', 'session_label', 'worktree_label', 'agent', 'scope_json', 'duration', 'triggered_by', 'detail_json', 'prev_hash', 'hash',
] as const;

/** Append-only, hash-chained audit log (spec §4.8, memo §8). Every grant/use/revoke/deny goes through here. */
export class AuditService {
  private readonly insert;
  private readonly lastRow;
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    this.insert = db.prepare(`INSERT INTO audit_entries (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`);
    this.lastRow = db.prepare('SELECT seq, hash FROM audit_entries ORDER BY seq DESC LIMIT 1');
  }

  append(input: AuditInput): AuditRow {
    // Free-text fields (shim argv, agent reasons, labels) are redacted before hashing so a secret never lands in the
    // chain: rows are immutable, so there is no second chance (rules/security.md).
    const safe: AuditInput = {
      ...input,
      actorLabel: redact(input.actorLabel),
      triggeredBy: redact(input.triggeredBy),
      ...(typeof input.targetLabel === 'string' ? { targetLabel: redact(input.targetLabel) } : {}),
      ...(typeof input.sessionLabel === 'string' ? { sessionLabel: redact(input.sessionLabel) } : {}),
      ...(typeof input.worktreeLabel === 'string' ? { worktreeLabel: redact(input.worktreeLabel) } : {}),
      ...(input.detail ? { detail: redact(input.detail) } : {}),
    };
    const tx = this.db.transaction((inp: AuditInput): AuditRow => {
      const last = this.lastRow.get() as { seq: number; hash: string } | undefined;
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = last?.hash ?? '';
      const row: Omit<AuditRow, 'hash'> = {
        id: ulid(),
        seq,
        time: inp.time ?? this.now(),
        actorKind: inp.actorKind,
        actorLabel: inp.actorLabel,
        action: inp.action,
        projectId: inp.projectId ?? null,
        targetId: inp.targetId ?? null,
        sessionId: inp.sessionId ?? null,
        worktreeId: inp.worktreeId ?? null,
        grantId: inp.grantId ?? null,
        policyId: inp.policyId ?? null,
        targetLabel: inp.targetLabel ?? null,
        sessionLabel: inp.sessionLabel ?? null,
        worktreeLabel: inp.worktreeLabel ?? null,
        agent: inp.agent ?? null,
        scopeJson: inp.scope ? JSON.stringify(inp.scope) : null,
        duration: inp.duration ?? null,
        triggeredBy: inp.triggeredBy,
        detailJson: inp.detail ? JSON.stringify(inp.detail) : null,
        prevHash,
      };
      const hash = hashRow(row);
      this.insert.run(
        row.id, row.seq, row.time, row.actorKind, row.actorLabel, row.action, row.projectId, row.targetId, row.sessionId, row.worktreeId,
        row.grantId, row.policyId, row.targetLabel, row.sessionLabel, row.worktreeLabel, row.agent, row.scopeJson, row.duration,
        row.triggeredBy, row.detailJson, row.prevHash, hash,
      );
      return { ...row, hash };
    });
    return tx(safe);
  }

  list(opts: { limit?: number; beforeSeq?: number; targetId?: string; sessionId?: string } = {}): AuditRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.beforeSeq !== undefined) { where.push('seq < ?'); params.push(opts.beforeSeq); }
    if (opts.targetId) { where.push('target_id = ?'); params.push(opts.targetId); }
    if (opts.sessionId) { where.push('session_id = ?'); params.push(opts.sessionId); }
    const sql = `SELECT * FROM audit_entries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`;
    params.push(opts.limit ?? 200);
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(fromDbRow);
  }

  get(id: string): AuditRow | null {
    const r = this.db.prepare('SELECT * FROM audit_entries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? fromDbRow(r) : null;
  }

  /** Walks the whole chain; returns the first broken seq or null when intact. */
  verifyChain(): { ok: true; count: number } | { ok: false; brokenAtSeq: number } {
    const rows = (this.db.prepare('SELECT * FROM audit_entries ORDER BY seq ASC').all() as Record<string, unknown>[]).map(fromDbRow);
    let prev = '';
    for (const r of rows) {
      if (r.prevHash !== prev) return { ok: false, brokenAtSeq: r.seq };
      const { hash, ...rest } = r;
      if (hashRow(rest) !== hash) return { ok: false, brokenAtSeq: r.seq };
      prev = hash;
    }
    return { ok: true, count: rows.length };
  }

  exportJson(): string {
    const entries = this.list({ limit: 1_000_000 }).reverse();
    const head = entries.at(-1)?.hash ?? '';
    return JSON.stringify({ version: 1, exportedAt: this.now(), chainHead: head, entries }, null, 2);
  }
}

/** Re-chains fixture rows (sorted by seq) so seeded audit logs verify. */
export function chainRows(rows: Omit<AuditRow, 'hash' | 'prevHash'>[]): AuditRow[] {
  const out: AuditRow[] = [];
  let prev = '';
  for (const r of [...rows].sort((a, b) => a.seq - b.seq)) {
    const row: Omit<AuditRow, 'hash'> = { ...r, prevHash: prev };
    const hash = hashRow(row);
    out.push({ ...row, hash });
    prev = hash;
  }
  return out;
}

export function hashRow(row: Omit<AuditRow, 'hash'>): string {
  const canonical = JSON.stringify(row, Object.keys(row).sort());
  return createHash('sha256').update(row.prevHash).update('\n').update(canonical).digest('hex');
}

function fromDbRow(r: Record<string, unknown>): AuditRow {
  const s = (k: string) => (r[k] === null || r[k] === undefined ? null : String(r[k]));
  return {
    id: String(r['id']),
    seq: Number(r['seq']),
    time: Number(r['time']),
    actorKind: String(r['actor_kind']) as AuditActorKind,
    actorLabel: String(r['actor_label']),
    action: String(r['action']) as AuditAction,
    projectId: s('project_id'),
    targetId: s('target_id'),
    sessionId: s('session_id'),
    worktreeId: s('worktree_id'),
    grantId: s('grant_id'),
    policyId: s('policy_id'),
    targetLabel: s('target_label'),
    sessionLabel: s('session_label'),
    worktreeLabel: s('worktree_label'),
    agent: s('agent'),
    scopeJson: s('scope_json'),
    duration: s('duration'),
    triggeredBy: String(r['triggered_by']),
    detailJson: s('detail_json'),
    prevHash: String(r['prev_hash']),
    hash: String(r['hash']),
  };
}
