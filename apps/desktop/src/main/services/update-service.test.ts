import { EventEmitter } from 'node:events';
import type { UpdateState } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../clock';
import { plainReason, UpdateService, type Updater } from './update-service';

/** electron-updater's `autoUpdater`, as far as Styx uses it: events in, check and quitAndInstall out. */
class FakeUpdater extends EventEmitter implements Updater {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checks = 0;
  installs: [boolean | undefined, boolean | undefined][] = [];
  async checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    return null;
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

const setup = (updater: FakeUpdater | null = new FakeUpdater()) => {
  const clock = new ManualClock(1_000);
  const published: UpdateState[] = [];
  const svc = new UpdateService({
    updater,
    version: '0.2.0',
    clock,
    publish: (s) => published.push(s),
    firstCheckMs: 10,
    intervalMs: 50,
  });
  return { svc, updater, clock, published };
};

describe('UpdateService (#119)', () => {
  it('off without an updater (development, e2e, a build with no feed): nothing checks, nothing installs', async () => {
    const { svc, published } = setup(null);
    expect(svc.current()).toEqual({
      current: '0.2.0',
      status: 'off',
      next: null,
      percent: null,
      checkedAt: null,
      error: null,
    });
    svc.start();
    await svc.check();
    expect(() => svc.install()).toThrow('No update is ready to install');
    expect(published).toEqual([]);
  });

  it('downloads in the background and installs on quit; the state follows the updater from check to ready', async () => {
    const { svc, updater, clock, published } = setup();
    if (updater === null) throw new Error('updater');
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(svc.current().status).toBe('idle');

    await svc.check();
    expect(updater.checks).toBe(1);
    updater.emit('checking-for-update');
    expect(svc.current().status).toBe('checking');
    clock.advance(500);
    updater.emit('update-available', { version: '0.2.1' });
    expect(svc.current()).toMatchObject({
      status: 'downloading',
      next: '0.2.1',
      percent: 0,
      checkedAt: 1_500,
    });
    updater.emit('download-progress', { percent: 12.7 });
    updater.emit('download-progress', { percent: 12.9 }); // same whole percent: not re-published
    updater.emit('download-progress', { percent: 57.2 });
    expect(published.filter((s) => s.status === 'downloading').map((s) => s.percent)).toEqual([0, 12, 57]);
    // A check while downloading or ready is not sent (the updater would start over).
    await svc.check();
    expect(updater.checks).toBe(1);
    updater.emit('update-downloaded', { version: '0.2.1' });
    expect(svc.current()).toMatchObject({ status: 'ready', next: '0.2.1', percent: 100, error: null });
    // A later failure (a background check offline) never takes an installable update away.
    updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect(svc.current().status).toBe('ready');
    svc.install();
    expect(updater.installs).toEqual([[false, true]]);
  });

  it('nothing new: idle with when it last asked; a failure is one plain line, never a stack', async () => {
    const { svc, updater, clock } = setup();
    if (updater === null) throw new Error('updater');
    clock.advance(2_000);
    updater.emit('update-not-available');
    expect(svc.current()).toMatchObject({ status: 'idle', checkedAt: 3_000, error: null });
    updater.emit('error', new Error('getaddrinfo ENOTFOUND storage.googleapis.com\n    at stack…'));
    expect(svc.current()).toMatchObject({ status: 'error', error: 'no connection' });
    updater.emit(
      'error',
      new Error('HttpError: 404 Not Found "method: GET url: https://x/latest-mac.yml?noCache=1"'),
    );
    expect(svc.current()).toMatchObject({ status: 'error', error: 'the update server did not answer' });
    // …and a new check clears it.
    updater.emit('checking-for-update');
    expect(svc.current()).toMatchObject({ status: 'checking', error: null });
    expect(() => svc.install()).toThrow('No update is ready to install');
  });

  it('checks shortly after start and then on the interval; stop ends it', async () => {
    vi.useFakeTimers();
    try {
      const { svc, updater } = setup();
      if (updater === null) throw new Error('updater');
      svc.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(updater.checks).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(updater.checks).toBe(3);
      svc.stop();
      await vi.advanceTimersByTimeAsync(500);
      expect(updater.checks).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('plainReason: offline shapes read as "no connection"; anything else as the server not answering', () => {
    for (const m of ['ENOTFOUND', 'EAI_AGAIN x', 'ECONNREFUSED', 'net::ERR_NAME_NOT_RESOLVED', 'ETIMEDOUT'])
      expect(plainReason(new Error(m))).toBe('no connection');
    expect(plainReason(new Error('sha512 checksum mismatch'))).toBe('the update server did not answer');
  });
});
