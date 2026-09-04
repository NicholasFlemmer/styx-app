import { notificationSchema, type Notification } from '@styx/core';
import type { Db } from '../open';
import { asBool, asNum, asStr, placeholders, toBit, type Raw } from './mappers';

const COLS =
  'id, kind, session_id, ask_id, project_id, title, body, meta, os_delivered, state, banner_key, created_at, resolved_at';

export const notificationFromRow = (r: Raw): Notification =>
  notificationSchema.parse({
    id: String(r['id']),
    kind: String(r['kind']),
    sessionId: asStr(r['session_id']),
    askId: asStr(r['ask_id']),
    projectId: asStr(r['project_id']),
    title: String(r['title']),
    body: String(r['body']),
    meta: asStr(r['meta']),
    osDelivered: asBool(r['os_delivered']),
    state: String(r['state']),
    bannerKey: asStr(r['banner_key']),
    createdAt: Number(r['created_at']),
    resolvedAt: asNum(r['resolved_at']),
  });

/** `notifications` table (toasts, needs-you rows, persistent banners keyed by `banner_key`). */
export class NotificationsRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly allStmt;
  private readonly byBannerStmt;
  private readonly byAskStmt;
  private readonly delStmt;

  constructor(private readonly db: Db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO notifications (${COLS}) VALUES (${placeholders(13)})
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, session_id = excluded.session_id, ask_id = excluded.ask_id, project_id = excluded.project_id, title = excluded.title,
         body = excluded.body, meta = excluded.meta, os_delivered = excluded.os_delivered, state = excluded.state, banner_key = excluded.banner_key, created_at = excluded.created_at,
         resolved_at = excluded.resolved_at`,
    );
    this.getStmt = db.prepare(`SELECT ${COLS} FROM notifications WHERE id = ?`);
    this.allStmt = db.prepare(`SELECT ${COLS} FROM notifications ORDER BY created_at ASC, rowid ASC`);
    this.byBannerStmt = db.prepare(`SELECT ${COLS} FROM notifications WHERE banner_key = ?`);
    this.byAskStmt = db.prepare(`SELECT ${COLS} FROM notifications WHERE ask_id = ?`);
    this.delStmt = db.prepare('DELETE FROM notifications WHERE id = ?');
  }

  upsert(n: Notification): void {
    this.upsertStmt.run(
      n.id,
      n.kind,
      n.sessionId,
      n.askId,
      n.projectId,
      n.title,
      n.body,
      n.meta,
      toBit(n.osDelivered),
      n.state,
      n.bannerKey,
      n.createdAt,
      n.resolvedAt,
    );
  }

  get(id: string): Notification | null {
    const r = this.getStmt.get(id) as Raw | undefined;
    return r ? notificationFromRow(r) : null;
  }

  byIds(ids: readonly string[]): Notification[] {
    if (ids.length === 0) return [];
    return (
      this.db
        .prepare(`SELECT ${COLS} FROM notifications WHERE id IN (${placeholders(ids.length)})`)
        .all(...ids) as Raw[]
    ).map(notificationFromRow);
  }

  all(): Notification[] {
    return (this.allStmt.all() as Raw[]).map(notificationFromRow);
  }

  byBannerKey(key: string): Notification | null {
    const r = this.byBannerStmt.get(key) as Raw | undefined;
    return r ? notificationFromRow(r) : null;
  }

  byAsk(askId: string): Notification[] {
    return (this.byAskStmt.all(askId) as Raw[]).map(notificationFromRow);
  }

  remove(id: string): void {
    this.delStmt.run(id);
  }
}
