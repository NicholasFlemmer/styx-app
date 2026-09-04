import { agentChangeSchema, type AgentChange } from '@styx/core';
import type { Db } from '../open';
import { asNum, placeholders, type Raw } from './mappers';

const COLS =
  'id, session_id, worktree_id, file, hunk_hash, old_start, old_lines, new_start, new_lines, patch, status, first_seen_at, last_seen_at, decided_at';

export const agentChangeFromRow = (r: Raw): AgentChange =>
  agentChangeSchema.parse({
    id: String(r['id']),
    sessionId: String(r['session_id']),
    worktreeId: String(r['worktree_id']),
    file: String(r['file']),
    hunkHash: String(r['hunk_hash']),
    oldStart: Number(r['old_start']),
    oldLines: Number(r['old_lines']),
    newStart: Number(r['new_start']),
    newLines: Number(r['new_lines']),
    patch: String(r['patch']),
    status: String(r['status']),
    firstSeenAt: Number(r['first_seen_at']),
    lastSeenAt: Number(r['last_seen_at']),
    decidedAt: asNum(r['decided_at']),
  });

/** `agent_changes` table: hunks attributed to a session (unique per worktree + content hash). */
export class AgentChangesRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly bySessionStmt;
  private readonly byWorktreeStmt;
  private readonly byHashStmt;
  private readonly sessionIdsStmt;
  private readonly delStmt;

  constructor(db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO agent_changes (${COLS}) VALUES (${placeholders(14)})
       ON CONFLICT(id) DO UPDATE SET file = excluded.file, hunk_hash = excluded.hunk_hash, old_start = excluded.old_start, old_lines = excluded.old_lines, new_start = excluded.new_start,
         new_lines = excluded.new_lines, patch = excluded.patch, status = excluded.status, first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at, decided_at = excluded.decided_at`,
    );
    this.getStmt = db.prepare(`SELECT ${COLS} FROM agent_changes WHERE id = ?`);
    this.bySessionStmt = db.prepare(
      `SELECT ${COLS} FROM agent_changes WHERE session_id = ? ORDER BY file ASC, new_start ASC, rowid ASC`,
    );
    this.byWorktreeStmt = db.prepare(
      `SELECT ${COLS} FROM agent_changes WHERE worktree_id = ? ORDER BY file ASC, new_start ASC, rowid ASC`,
    );
    this.byHashStmt = db.prepare(`SELECT ${COLS} FROM agent_changes WHERE worktree_id = ? AND hunk_hash = ?`);
    this.sessionIdsStmt = db.prepare('SELECT DISTINCT session_id FROM agent_changes');
    this.delStmt = db.prepare('DELETE FROM agent_changes WHERE id = ?');
  }

  upsert(c: AgentChange): void {
    this.upsertStmt.run(
      c.id,
      c.sessionId,
      c.worktreeId,
      c.file,
      c.hunkHash,
      c.oldStart,
      c.oldLines,
      c.newStart,
      c.newLines,
      c.patch,
      c.status,
      c.firstSeenAt,
      c.lastSeenAt,
      c.decidedAt,
    );
  }

  get(id: string): AgentChange | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? agentChangeFromRow(r) : null;
  }

  bySession(sessionId: string): AgentChange[] {
    return (this.bySessionStmt.all(sessionId) as Raw[]).map(agentChangeFromRow);
  }

  byWorktree(worktreeId: string): AgentChange[] {
    return (this.byWorktreeStmt.all(worktreeId) as Raw[]).map(agentChangeFromRow);
  }

  byHash(worktreeId: string, hunkHash: string): AgentChange | null {
    const r = this.byHashStmt.get(worktreeId, hunkHash) as Raw | undefined;
    return r ? agentChangeFromRow(r) : null;
  }

  sessionIds(): string[] {
    return (this.sessionIdsStmt.all() as { session_id: string }[]).map((r) => r.session_id);
  }

  remove(id: string): void {
    this.delStmt.run(id);
  }
}
