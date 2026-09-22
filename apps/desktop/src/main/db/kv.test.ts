import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from './migrate';
import { KvStore, WindowStateStore } from './kv';

describe('KvStore / WindowStateStore', () => {
  it('round-trips JSON values and window bounds', () => {
    const db = new Database(':memory:');
    migrate(db);
    const kv = new KvStore(db, 'ui_state', () => 5);
    kv.set('ui.screen', 'workspace');
    kv.set('ui.paneSizes', { terminal: 130 });
    expect(kv.get<string>('ui.screen')).toBe('workspace');
    expect(kv.all()).toEqual({ 'ui.screen': 'workspace', 'ui.paneSizes': { terminal: 130 } });
    kv.delete('ui.screen');
    expect(kv.get('ui.screen')).toBeUndefined();

    const ws = new WindowStateStore(db, () => 5);
    expect(ws.get('main')).toBeUndefined();
    ws.set('popout:s1', { x: 10, y: 20, width: 400, height: 500, displayId: 'd1' });
    expect(ws.get('popout:s1')).toEqual({
      x: 10,
      y: 20,
      width: 400,
      height: 500,
      displayId: 'd1',
      maximized: false,
    });
    ws.set('popout:s1', { width: 420, height: 520, maximized: true });
    expect(ws.get('popout:s1')).toEqual({ width: 420, height: 520, maximized: true });
  });
});
