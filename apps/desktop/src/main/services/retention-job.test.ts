import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtures, RETENTION_MS } from '@styx/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import { PtyLog } from './pty-log';

const { ids, DEMO_NOW } = fixtures;
const DAY = 24 * 60 * 60 * 1000;

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.shutdown();
  t = null;
  vi.useRealTimers();
});

describe('RetentionJob', () => {
  it('archives done sessions older than 7 days and deletes their pty logs; younger ones stay', () => {
    t = makeTestApp();
    const { app, clock } = t;
    const old = app.repos.sessions.get(ids.session.cursor)!;
    app.repos.sessions.upsert({ ...old, state: 'done', endedAt: DEMO_NOW - 8 * DAY, pid: null, exitCode: 0 });
    const young = app.repos.sessions.get(ids.session.side)!;
    app.repos.sessions.upsert({
      ...young,
      state: 'done',
      endedAt: DEMO_NOW - 1 * DAY,
      pid: null,
      exitCode: 0,
    });
    const logDir = app.ptyLog.dir;
    mkdirSync(logDir, { recursive: true });
    const oldLog = join(logDir, `${old.id}.log`);
    writeFileSync(oldLog, 'bytes');
    writeFileSync(`${oldLog}.1`, 'rotated');
    const youngLog = join(logDir, `${young.id}.log`);
    writeFileSync(youngLog, 'bytes');

    expect(app.retention.run()).toEqual([old.id]);
    expect(app.repos.sessions.get(old.id)?.archivedAt).toBe(DEMO_NOW);
    expect(app.repos.sessions.get(young.id)?.archivedAt).toBeNull();
    expect(existsSync(oldLog)).toBe(false);
    expect(existsSync(`${oldLog}.1`)).toBe(false);
    expect(existsSync(youngLog)).toBe(true);
    expect(app.retention.run()).toEqual([]); // already archived

    clock.advance(RETENTION_MS);
    expect(app.retention.run()).toEqual([young.id]);
    expect(existsSync(youngLog)).toBe(false);
  });

  it('runs on start and then hourly on the injected clock', () => {
    vi.useFakeTimers();
    t = makeTestApp();
    const { app, clock } = t;
    const s = app.repos.sessions.get(ids.session.cursor)!;
    app.repos.sessions.upsert({
      ...s,
      state: 'done',
      endedAt: DEMO_NOW - 6 * DAY - 23 * 60 * 60 * 1000,
      pid: null,
      exitCode: 0,
    });
    app.retention.start();
    expect(app.repos.sessions.get(s.id)?.archivedAt).toBeNull();
    clock.advance(2 * 60 * 60 * 1000);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(app.repos.sessions.get(s.id)?.archivedAt).toBe(clock.now());
    app.retention.stop();
  });
});

describe('PtyLog', () => {
  it('appends and rotates once past the byte limit', () => {
    t = makeTestApp();
    const log = new PtyLog(join(t.userData, 'logs', 'pty-test'), 10);
    log.write('s', '12345');
    log.write('s', '1234');
    expect(existsSync(log.path('s'))).toBe(true);
    log.write('s', 'abcdef'); // 9 + 6 > 10 → rotate
    expect(existsSync(`${log.path('s')}.1`)).toBe(true);
    log.close('s');
    log.remove('s');
    expect(existsSync(log.path('s'))).toBe(false);
    expect(existsSync(`${log.path('s')}.1`)).toBe(false);
  });
});
