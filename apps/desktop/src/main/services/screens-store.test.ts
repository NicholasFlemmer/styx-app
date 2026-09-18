import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScreensStore } from './screens-store';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

describe('ScreensStore', () => {
  const dirs: string[] = [];
  const make = () => {
    const dir = mkdtempSync(join(tmpdir(), 'styx-screens-'));
    dirs.push(dir);
    return new ScreensStore(join(dir, 'screens'));
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('keeps one live frame per project with a rising seq, resolvable by URL', async () => {
    const s = make();
    expect(s.putFrame('p1', PNG)).toBe(1);
    expect(s.putFrame('p1', Buffer.concat([PNG, PNG]))).toBe(2);
    expect((await s.resolve('styx-device://frame/p1?seq=2'))?.length).toBe(16);
    s.dropFrame('p1');
    expect(await s.resolve('styx-device://frame/p1')).toBeNull();
  });

  it('writes checkpoint screenshots to disk and serves them by checkpoint and side', async () => {
    const s = make();
    await s.putScreen('cp-1', 'before', PNG);
    expect(await s.resolve('styx-device://checkpoint/cp-1/before')).toEqual(PNG);
    expect(await s.resolve('styx-device://checkpoint/cp-1/after')).toBeNull();
    await s.dropScreens('cp-1');
    expect(await s.resolve('styx-device://checkpoint/cp-1/before')).toBeNull();
  });

  it('refuses keys that could leave the directory and unknown hosts', async () => {
    const s = make();
    await s.putScreen('../etc', 'before', PNG); // silently dropped
    expect(await s.resolve('styx-device://checkpoint/../etc/before')).toBeNull();
    expect(await s.resolve('styx-device://checkpoint/cp-1/sideways')).toBeNull();
    expect(await s.resolve('styx-device://other/cp-1')).toBeNull();
    expect(await s.resolve('not a url')).toBeNull();
  });
});
