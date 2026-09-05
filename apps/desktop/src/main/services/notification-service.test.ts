import Database from 'better-sqlite3';
import { fixtures } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { migrate } from '../db/migrate';
import { KvStore } from '../db/kv';
import { makeTestApp } from '../test-support';
import { bannersToReemit, NotificationService, type AskSummary, type OsNotifier } from './notification-service';

const ask: AskSummary = { askId: 'a1', sessionId: 's1', projectName: 'acme-shop', branch: 'test/flaky', agentLabel: 'Codex', title: 'Codex wants Supabase prod · write', meta: 'acme-shop · test/flaky · "migration 0042"' };

function make(platform: NodeJS.Platform) {
  const db = new Database(':memory:');
  migrate(db);
  const os: OsNotifier = { setBadge: vi.fn(), bounceOnce: vi.fn(), toast: vi.fn(), setTray: vi.fn() };
  const actions = { review: vi.fn(), later: vi.fn(), openBoard: vi.fn() };
  let sound = false;
  return { os, actions, setSound: (v: boolean) => (sound = v), svc: new NotificationService(os, new KvStore(db, 'ui_state'), platform, actions, () => sound) };
}

describe('NotificationService', () => {
  it('badges, bounces once, toasts, and respects DND', () => {
    const { os, svc, actions } = make('darwin');
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
    const tray = (os.setTray as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as { attention: boolean; menu: { label: string; checked?: boolean }[]; onClick: () => void };
    expect(tray.attention).toBe(true);
    expect(tray.menu[0]?.label).toBe('2 need you');
    expect(tray.menu.at(-1)).toMatchObject({ label: 'Do Not Disturb', checked: true });
    tray.onClick();
    expect(actions.openBoard).toHaveBeenCalledTimes(1);
  });

  it('start() puts the tray/dock menu up with the persisted count; sound follows the app setting', () => {
    const { os, svc, setSound } = make('win32');
    svc.start(1);
    expect(os.setBadge).toHaveBeenLastCalledWith(1);
    expect(os.setTray).toHaveBeenLastCalledWith(expect.objectContaining({ attention: true }));
    svc.onAskOpened(ask, 1);
    expect(os.toast).toHaveBeenLastCalledWith(expect.objectContaining({ sound: false }));
    setSound(true);
    svc.onAskOpened({ ...ask, askId: 'a2' }, 2);
    expect(os.toast).toHaveBeenLastCalledWith(expect.objectContaining({ sound: true }));
  });

  it('does not bounce on Windows and resets bounce when the queue empties', () => {
    const { os, svc } = make('win32');
    svc.onAskOpened(ask, 1);
    expect(os.bounceOnce).not.toHaveBeenCalled();
    svc.onAskResolved('a1', 0);
    expect(os.setBadge).toHaveBeenLastCalledWith(0);
  });
});

describe('bannersToReemit', () => {
  it('rebuilds banner.set payloads for shown persistent banners only, and store.snapshot re-emits them', async () => {
    const t = makeTestApp();
    const { ids } = fixtures;
    const now = t.clock.now();
    const base = { kind: 'error-banner' as const, sessionId: null, askId: null, projectId: ids.project.acmeShop, body: '', meta: null, osDelivered: false, createdAt: now, resolvedAt: null };
    t.app.repos.notifications.upsert({ ...base, id: 'b1', title: 'Vercel: credentials expired 2h ago.', state: 'shown', bannerKey: `auth-expired:${ids.target.vercelProd}` });
    t.app.repos.notifications.upsert({ ...base, id: 'b2', title: 'fix/checkout conflicts with main in a.ts.', state: 'shown', bannerKey: `conflict:${ids.worktree.fixCheckout}`, sessionId: ids.session.claude });
    t.app.repos.notifications.upsert({ ...base, id: 'b3', title: 'codex not found on PATH.', state: 'shown', bannerKey: 'cli-missing:codex' });
    t.app.repos.notifications.upsert({ ...base, id: 'b4', title: 'gone', state: 'resolved', bannerKey: 'cli-missing:gemini', resolvedAt: now });
    t.app.repos.notifications.upsert({ ...base, id: 'b5', title: 'unknown', state: 'shown', bannerKey: 'auth-expired:missing-target' });
    t.app.repos.notifications.upsert({ ...base, id: 'b6', title: 'weird', state: 'shown', bannerKey: 'what:ever' });
    const banners = bannersToReemit(t.app.repos);
    expect(banners.map((b) => [b.bannerKey, b.kind, b.cta, b.action, b.sessionId])).toEqual([
      [`auth-expired:${ids.target.vercelProd}`, 'auth-expired', 'Reconnect', { kind: 'reconnect', targetId: ids.target.vercelProd }, null],
      [`conflict:${ids.worktree.fixCheckout}`, 'conflict', 'Resolve', { kind: 'resolve', worktreeId: ids.worktree.fixCheckout }, ids.session.claude],
      ['cli-missing:codex', 'cli-missing', 'Install guide', { kind: 'install-guide', agent: 'codex' }, null],
    ]);
    const r = await t.app.bus.dispatch(t.sender, 'store.snapshot', {});
    expect(r.ok).toBe(true);
    expect(t.win.events('banner.set').map((e) => (e as { bannerKey: string }).bannerKey)).toEqual(banners.map((b) => b.bannerKey));
  });
});
