import { queuedMessageSchema, type QueuedMessage } from '@styx/core';
import type { Db } from '../open';
import { asJson, placeholders, type Raw } from './mappers';

const COLS = 'id, session_id, body, files_json, created_at';

export const queuedMessageFromRow = (r: Raw): QueuedMessage =>
  queuedMessageSchema.parse({
    id: String(r['id']),
    sessionId: String(r['session_id']),
    body: String(r['body']),
    files: asJson<string[]>(r['files_json'], []),
    createdAt: Number(r['created_at']),
  });

/** `queued_messages` table (0015): user turns held back while the agent is mid-turn, oldest first. */
export class QueuedMessagesRepo {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly bySessionStmt;
  private readonly sessionIdsStmt;
  private readonly delStmt;

  constructor(db: Db) {
    this.insertStmt = db.prepare(`INSERT INTO queued_messages (${COLS}) VALUES (${placeholders(5)})`);
    this.getStmt = db.prepare(`SELECT ${COLS} FROM queued_messages WHERE id = ?`);
    this.bySessionStmt = db.prepare(
      `SELECT ${COLS} FROM queued_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
    );
    this.sessionIdsStmt = db.prepare('SELECT DISTINCT session_id FROM queued_messages');
    this.delStmt = db.prepare('DELETE FROM queued_messages WHERE id = ?');
  }

  insert(m: QueuedMessage): void {
    this.insertStmt.run(m.id, m.sessionId, m.body, JSON.stringify(m.files), m.createdAt);
  }

  get(id: string): QueuedMessage | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? queuedMessageFromRow(r) : null;
  }

  bySession(sessionId: string): QueuedMessage[] {
    return (this.bySessionStmt.all(sessionId) as Raw[]).map(queuedMessageFromRow);
  }

  sessionIds(): string[] {
    return (this.sessionIdsStmt.all() as { session_id: string }[]).map((r) => r.session_id);
  }

  remove(id: string): void {
    this.delStmt.run(id);
  }
}
