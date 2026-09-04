import { transcriptMessageSchema, type TranscriptMessage } from '@styx/core';
import type { Db } from '../open';
import { asJson, asStr, placeholders, toJson, type Raw } from './mappers';

const COLS = 'id, session_id, seq, kind, body, payload_json, ask_id, created_at';

export const messageFromRow = (r: Raw): TranscriptMessage =>
  transcriptMessageSchema.parse({
    id: String(r['id']),
    sessionId: String(r['session_id']),
    seq: Number(r['seq']),
    body: String(r['body']),
    payload: asJson<unknown>(r['payload_json'], { kind: String(r['kind']) }),
    askId: asStr(r['ask_id']),
    createdAt: Number(r['created_at']),
  });

/** `transcript_messages` table; `kind` mirrors `payload.kind` for the CHECK constraint. */
export class TranscriptsRepo {
  private readonly upsertStmt;
  private readonly lastStmt;
  private readonly nextSeqStmt;
  private readonly getStmt;
  private readonly patchStmt;
  private readonly sessionIdsStmt;

  constructor(db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO transcript_messages (${COLS}) VALUES (${placeholders(8)})
       ON CONFLICT(id) DO UPDATE SET body = excluded.body, payload_json = excluded.payload_json, ask_id = excluded.ask_id`,
    );
    this.lastStmt = db.prepare(
      `SELECT ${COLS} FROM (SELECT ${COLS} FROM transcript_messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`,
    );
    this.nextSeqStmt = db.prepare(
      'SELECT COALESCE(MAX(seq), -1) + 1 AS s FROM transcript_messages WHERE session_id = ?',
    );
    this.getStmt = db.prepare(`SELECT ${COLS} FROM transcript_messages WHERE id = ?`);
    this.patchStmt = db.prepare('UPDATE transcript_messages SET body = ? WHERE id = ?');
    this.sessionIdsStmt = db.prepare('SELECT DISTINCT session_id FROM transcript_messages');
  }

  upsert(m: TranscriptMessage): void {
    this.upsertStmt.run(
      m.id,
      m.sessionId,
      m.seq,
      m.payload.kind,
      m.body,
      toJson(m.payload),
      m.askId,
      m.createdAt,
    );
  }

  /** Last `limit` messages, oldest first. */
  last(sessionId: string, limit = 200): TranscriptMessage[] {
    return (this.lastStmt.all(sessionId, limit) as Raw[]).map(messageFromRow);
  }

  nextSeq(sessionId: string): number {
    return Number((this.nextSeqStmt.get(sessionId) as { s: number }).s);
  }

  get(id: string): TranscriptMessage | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? messageFromRow(r) : null;
  }

  patchBody(id: string, body: string): void {
    this.patchStmt.run(body, id);
  }

  sessionIds(): string[] {
    return (this.sessionIdsStmt.all() as { session_id: string }[]).map((r) => r.session_id);
  }
}
