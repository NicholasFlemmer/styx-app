import { checkpointSchema, type Checkpoint } from '@styx/core';
import type { Db } from '../open';
import { asNum, asStr, placeholders, type Raw } from './mappers';

const COLS =
  'id, session_id, worktree_id, turn, message_id, base_ref, ref, files, added, removed, created_at, settled_at, reverted_at';

export const checkpointFromRow = (r: Raw): Checkpoint =>
  checkpointSchema.parse({
    id: String(r['id']),
    sessionId: String(r['session_id']),
    worktreeId: String(r['worktree_id']),
    turn: Number(r['turn']),
    messageId: asStr(r['message_id']),
    baseRef: String(r['base_ref']),
    ref: asStr(r['ref']),
    files: Number(r['files'] ?? 0),
    added: Number(r['added'] ?? 0),
    removed: Number(r['removed'] ?? 0),
    createdAt: Number(r['created_at']),
    settledAt: asNum(r['settled_at']),
    revertedAt: asNum(r['reverted_at']),
  });

/** `checkpoints` table (0015): one row per agent turn, hidden git refs behind it. */
export class CheckpointsRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly bySessionStmt;
  private readonly sessionIdsStmt;
  private readonly delStmt;

  constructor(db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO checkpoints (${COLS}) VALUES (${placeholders(13)})
       ON CONFLICT(id) DO UPDATE SET message_id = excluded.message_id, base_ref = excluded.base_ref, ref = excluded.ref, files = excluded.files,
         added = excluded.added, removed = excluded.removed, settled_at = excluded.settled_at, reverted_at = excluded.reverted_at`,
    );
    this.getStmt = db.prepare(`SELECT ${COLS} FROM checkpoints WHERE id = ?`);
    this.bySessionStmt = db.prepare(`SELECT ${COLS} FROM checkpoints WHERE session_id = ? ORDER BY turn ASC`);
    this.sessionIdsStmt = db.prepare('SELECT DISTINCT session_id FROM checkpoints');
    this.delStmt = db.prepare('DELETE FROM checkpoints WHERE id = ?');
  }

  upsert(c: Checkpoint): void {
    this.upsertStmt.run(
      c.id,
      c.sessionId,
      c.worktreeId,
      c.turn,
      c.messageId,
      c.baseRef,
      c.ref,
      c.files,
      c.added,
      c.removed,
      c.createdAt,
      c.settledAt,
      c.revertedAt,
    );
  }

  get(id: string): Checkpoint | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? checkpointFromRow(r) : null;
  }

  bySession(sessionId: string): Checkpoint[] {
    return (this.bySessionStmt.all(sessionId) as Raw[]).map(checkpointFromRow);
  }

  sessionIds(): string[] {
    return (this.sessionIdsStmt.all() as { session_id: string }[]).map((r) => r.session_id);
  }

  remove(id: string): void {
    this.delStmt.run(id);
  }
}
