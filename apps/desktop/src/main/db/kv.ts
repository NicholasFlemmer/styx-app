import type { Db } from './open';

/** Typed key/value access for the `ui_state` and `app_settings` tables (JSON values, epoch-ms updated_at). */
export class KvStore {
  private readonly getStmt;
  private readonly setStmt;
  private readonly delStmt;
  private readonly allStmt;
  constructor(
    db: Db,
    table: 'ui_state' | 'app_settings',
    private readonly now: () => number = Date.now,
  ) {
    this.getStmt = db.prepare(`SELECT value_json FROM ${table} WHERE key = ?`);
    this.setStmt = db.prepare(
      `INSERT INTO ${table} (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    );
    this.delStmt = db.prepare(`DELETE FROM ${table} WHERE key = ?`);
    this.allStmt = db.prepare(`SELECT key, value_json FROM ${table}`);
  }
  get<T>(key: string): T | undefined {
    const r = this.getStmt.get(key) as { value_json: string } | undefined;
    return r ? (JSON.parse(r.value_json) as T) : undefined;
  }
  set(key: string, value: unknown): void {
    this.setStmt.run(key, JSON.stringify(value), this.now());
  }
  delete(key: string): void {
    this.delStmt.run(key);
  }
  all(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.allStmt.all() as { key: string; value_json: string }[])
      out[r.key] = JSON.parse(r.value_json);
    return out;
  }
}

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  displayId?: string;
  maximized?: boolean;
}

export class WindowStateStore {
  private readonly getStmt;
  private readonly setStmt;
  constructor(
    db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.getStmt = db.prepare(
      'SELECT x, y, width, height, display_id, maximized FROM window_state WHERE key = ?',
    );
    this.setStmt = db.prepare(
      'INSERT INTO window_state (key, x, y, width, height, display_id, maximized, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height, display_id = excluded.display_id, maximized = excluded.maximized, updated_at = excluded.updated_at',
    );
  }
  get(key: string): WindowBounds | undefined {
    const r = this.getStmt.get(key) as
      | {
          x: number | null;
          y: number | null;
          width: number;
          height: number;
          display_id: string | null;
          maximized: number;
        }
      | undefined;
    if (!r) return undefined;
    return {
      ...(r.x !== null ? { x: r.x } : {}),
      ...(r.y !== null ? { y: r.y } : {}),
      width: r.width,
      height: r.height,
      ...(r.display_id ? { displayId: r.display_id } : {}),
      maximized: r.maximized === 1,
    };
  }
  set(key: string, b: WindowBounds): void {
    this.setStmt.run(
      key,
      b.x ?? null,
      b.y ?? null,
      b.width,
      b.height,
      b.displayId ?? null,
      b.maximized ? 1 : 0,
      this.now(),
    );
  }
}
