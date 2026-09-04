import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migrate } from '../db/migrate';
import { KvStore } from '../db/kv';
import { NotificationService, type AskSummary, type OsNotifier } from './notification-service';

const ask: AskSummary = { askId: 'a1', sessionId: 's1', projectName: 'acme-shop', branch: 'test/flaky', agentLabel: 'Codex', title: 'Codex wants Supabase prod · write', meta: 'acme-shop · test/flaky · "migration 0042"' };

function make(platform: NodeJS.Platform) {
  const db = new Database(':memory:');
  migrate(db);
  const os: OsNotifier = { setBadge: vi.fn(), bounceOnce: vi.fn(), toast: vi.fn(), setTray: vi.fn() };
  const actions = { review: vi.fn(), later: vi.fn(), openBoard: vi.fn() };
  return { os, actions, svc: new NotificationService(os, new KvStore(db, 'ui_state'), platform, actions) };
}

describe('NotificationService', () => {
  it('badges, bounces once, toasts, and respects DND', () => {
    const { os, svc } = make('darwin');
    svc.onAskOpened(ask, 1);
    svc.onAskOpened({ ...ask, askId: 'a2' }, 2);
    expect(os.setBadge).toHaveBeenLastCalledWith(2);
    expect(os.bounceOnce).toHaveBeenCalledTimes(1);
    expect(os.toast).toHaveBeenCalledTimes(2);
    svc.setDnd(true);
    svc.onAskOpened({ ...ask, askId: 'a3' }, 3);
    expect(os.toast).toHaveBeenCalledTimes(2);
    svc.onAskResolved('a1', 2);
    expect(os.setBadge).toHaveBeenLastCalledWith(2);
    const tray = (os.setTray as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as { attention: boolean; menu: { label: string }[] };
    expect(tray.attention).toBe(true);
    expect(tray.menu[0]?.label).toBe('2 need you');
  });

  it('does not bounce on Windows and resets bounce when the queue empties', () => {
    const { os, svc } = make('win32');
    svc.onAskOpened(ask, 1);
    expect(os.bounceOnce).not.toHaveBeenCalled();
    svc.onAskResolved('a1', 0);
    expect(os.setBadge).toHaveBeenLastCalledWith(0);
  });
});
