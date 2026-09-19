import { copy, type DeviceInput, type DeviceSession, type ProjectId } from '@styx/core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repos } from '../db/repos';
import type { Publisher } from '../store/publisher';
import {
  androidText,
  ARM_TTL_MS,
  DeviceService,
  humaniseRuntime,
  matchWindowSource,
  parseAdbSerials,
  parseAndroidDevices,
  parseSimctlList,
  parseWmSize,
  pickDevice,
  pngSize,
  sortDevices,
  type DeviceExec,
  type DeviceExecOptions,
  type DeviceExecResult,
  type ScreenAccess,
  type WindowSource,
} from './device-service';
import { ScreensStore } from './screens-store';

const simctl = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: 'A1', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
      { udid: 'A2', name: 'iPhone 17', state: 'Booted', isAvailable: true },
      { udid: 'A3', name: 'iPad Air 13-inch (M3)', state: 'Shutdown', isAvailable: true },
      { udid: 'A4', name: 'iPhone SE (3rd generation)', state: 'Shutdown', isAvailable: false },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [
      { udid: 'W1', name: 'Apple Watch Ultra 3 (49mm)', state: 'Shutdown', isAvailable: true },
    ],
  },
});

/** A real (decodable) RGB PNG: signature, IHDR, one deflated IDAT, IEND. */
export const makePng = (width: number, height: number, rgb: [number, number, number] = [0, 0, 0]): Buffer => {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(rgb, y * stride + 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

describe('parseSimctlList', () => {
  it('lists available simulators with a readable runtime, booted first', () => {
    const list = parseSimctlList(simctl);
    expect(list.map((d) => [d.name, d.state, d.runtime])).toEqual([
      ['iPhone 17', 'booted', 'iOS 26.5'],
      ['Apple Watch Ultra 3 (49mm)', 'shutdown', 'watchOS 12.0'],
      ['iPad Air 13-inch (M3)', 'shutdown', 'iOS 26.5'],
      ['iPhone 17 Pro', 'shutdown', 'iOS 26.5'],
    ]);
    expect(list.every((d) => d.platform === 'ios')).toBe(true);
  });

  it('tolerates garbage', () => {
    expect(parseSimctlList('not json')).toEqual([]);
    expect(parseSimctlList('{"devices":{"x":"nope"}}')).toEqual([]);
  });

  it('humanises runtime ids', () => {
    expect(humaniseRuntime('com.apple.CoreSimulator.SimRuntime.iOS-18-2')).toBe('iOS 18.2');
    expect(humaniseRuntime('com.apple.CoreSimulator.SimRuntime.iOS-26-5-1')).toBe('iOS 26.5.1');
    expect(humaniseRuntime('iOS 17')).toBe('iOS 17');
    expect(humaniseRuntime('')).toBeNull();
  });
});

describe('parseAndroidDevices', () => {
  it('lists AVDs and running emulators, running first', () => {
    const list = parseAndroidDevices(
      'INFO    | Storing crashdata in: /tmp\nPixel_8_API_35\nPixel_Tablet_API_34\n',
      'List of devices attached\nemulator-5554\tdevice product:sdk_gphone64_arm64 model:sdk_gphone64_arm64\n',
    );
    expect(list.map((d) => [d.id, d.name, d.state])).toEqual([
      ['emulator-5554', 'emulator-5554', 'booted'],
      ['Pixel_8_API_35', 'Pixel 8 API 35', 'shutdown'],
      ['Pixel_Tablet_API_34', 'Pixel Tablet API 34', 'shutdown'],
    ]);
  });

  it('parseAdbSerials keeps emulators only, with their state', () => {
    expect(
      parseAdbSerials(
        'List of devices attached\nemulator-5554\tdevice product:x\nemulator-5556\toffline\nR58M1234\tdevice\n',
      ),
    ).toEqual([
      { serial: 'emulator-5554', state: 'device' },
      { serial: 'emulator-5556', state: 'offline' },
    ]);
  });
});

describe('parseWmSize', () => {
  it.each([
    ['physical', 'Physical size: 1080x2400\n', { width: 1080, height: 2400 }],
    ['override wins', 'Physical size: 1080x2400\nOverride size: 720x1600\n', { width: 720, height: 1600 }],
    ['garbage', 'error: no devices/emulators found', null],
    ['zero', 'Physical size: 0x0', null],
  ])('%s', (_name, text, expected) => {
    expect(parseWmSize(text)).toEqual(expected);
  });
});

describe('pngSize', () => {
  it('reads width and height from the IHDR of a real PNG', () => {
    expect(pngSize(makePng(393, 852))).toEqual({ width: 393, height: 852 });
    expect(pngSize(makePng(2, 1))).toEqual({ width: 2, height: 1 });
  });
  it('rejects anything that is not a PNG', () => {
    expect(pngSize(Buffer.from('not a png at all, really not'))).toBeNull();
    expect(pngSize(Buffer.alloc(10))).toBeNull();
    const bad = makePng(4, 4);
    bad.write('IHDX', 12, 'latin1');
    expect(pngSize(bad)).toBeNull();
  });
});

describe('androidText', () => {
  it('encodes spaces the way `input text` wants them', () => {
    expect(androidText('hello world 2')).toBe('hello%sworld%s2');
  });
});

describe('pickDevice', () => {
  const list = sortDevices(parseSimctlList(simctl));
  it('prefers the asked name, then the remembered one, then a booted device, then an iPhone', () => {
    expect(pickDevice(list, 'iPhone 17 Pro', null)?.id).toBe('A1');
    expect(pickDevice(list, 'ipad', null)?.id).toBe('A3'); // case-insensitive prefix
    expect(pickDevice(list, null, 'iPhone 17 Pro')?.id).toBe('A1');
    expect(pickDevice(list, null, null)?.id).toBe('A2'); // booted
    const shut = list.map((d) => ({ ...d, state: 'shutdown' as const }));
    expect(pickDevice(shut, null, null)?.name).toMatch(/^iPhone/);
    expect(pickDevice([], null, null)).toBeNull();
  });
});

describe('matchWindowSource', () => {
  const sources = [
    { id: 'window:1:0', name: 'Styx' },
    { id: 'window:2:0', name: 'iPhone 17 Pro – iOS 26.5' },
    { id: 'window:3:0', name: 'iPhone 17 – iOS 26.5' },
    { id: 'window:4:0', name: 'Android Emulator - Pixel_8_API_35:5554' },
  ];
  it('finds the simulator window by device name and the emulator window by AVD', () => {
    expect(matchWindowSource(sources, { platform: 'ios', name: 'iPhone 17', id: 'A2' })?.id).toBe(
      'window:3:0',
    );
    expect(matchWindowSource(sources, { platform: 'ios', name: 'iPhone 17 Pro', id: 'A1' })?.id).toBe(
      'window:2:0',
    );
    expect(
      matchWindowSource(sources, { platform: 'android', name: 'Pixel 8 API 35', id: 'Pixel_8_API_35' })?.id,
    ).toBe('window:4:0');
    expect(matchWindowSource(sources, { platform: 'ios', name: 'iPad Air', id: 'A3' })).toBeNull();
    // With the runtime known, a browser tab about the phone is not the simulator; two candidates are none.
    const tab = { id: 'window:5:0', name: 'iPhone 17 Pro - Apple - Google Chrome' };
    expect(
      matchWindowSource([...sources, tab], {
        platform: 'ios',
        name: 'iPhone 17 Pro',
        id: 'A1',
        runtime: 'iOS 26.5',
      })?.id,
    ).toBe('window:2:0');
    expect(
      matchWindowSource([...sources, tab], { platform: 'ios', name: 'iPhone 17 Pro', id: 'A1' }),
    ).toBeNull();
    expect(
      matchWindowSource([tab], { platform: 'ios', name: 'iPhone 17 Pro', id: 'A1', runtime: 'iOS 26.5' }),
    ).toBeNull();
  });
});

// --- the service over a routed fake exec ------------------------------------------------------------------

type Answer =
  | Partial<DeviceExecResult>
  | ((
      args: string[],
      nth: number,
      opts: DeviceExecOptions | undefined,
    ) => Partial<DeviceExecResult> | Promise<Partial<DeviceExecResult>>);

/** Answers by the longest `bin args…` prefix that matches; records every line; unknown lines exit 2. */
const fakeExec = (routes: Record<string, Answer>) => {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  const exec: DeviceExec = async (bin, args, opts) => {
    const line = `${bin} ${args.join(' ')}`;
    calls.push(line);
    const key = keys.find((k) => line === k || line.startsWith(`${k} `));
    if (key === undefined) return { stdout: '', stderr: `fake: ${line} is not supported`, exitCode: 2 };
    const nth = (counts.get(key) ?? 0) + 1;
    counts.set(key, nth);
    const a = routes[key];
    const r = typeof a === 'function' ? await a(args, nth, opts) : (a ?? {});
    return { stdout: '', stderr: '', exitCode: 0, ...r };
  };
  return { exec, calls };
};

const acme = 'proj:01ACME' as ProjectId;
const shot = makePng(393, 852, [10, 20, 30]);

/** iOS routes for a Mac with Xcode: A1 shut down, A2 booted; `open` fails (no Simulator.app, tolerated). */
const iosRoutes = (over: Record<string, Answer> = {}): Record<string, Answer> => ({
  'xcrun simctl help': {},
  'xcrun simctl list devices available -j': { stdout: simctl },
  'xcrun simctl boot A1': {},
  'xcrun simctl boot A2': { exitCode: 149, stderr: 'Unable to boot device in current state: Booted' },
  'xcrun simctl bootstatus': {},
  'open -a Simulator --args -CurrentDeviceUDID': { exitCode: 1, stderr: 'Unable to find application' },
  'open -a Simulator': {},
  'xcrun simctl io': (args) => {
    const file = args.at(-1);
    if (file !== undefined) writeFileSync(file, shot);
    return {};
  },
  'xcrun simctl shutdown': {},
  ...over,
});

const androidRoutes = (over: Record<string, Answer> = {}): Record<string, Answer> => ({
  'adb version': { stdout: 'Android Debug Bridge version 1.0.41' },
  'emulator -list-avds': { stdout: 'Pixel_8_API_35\n' },
  'adb devices -l': { stdout: 'List of devices attached\n' },
  'adb -s emulator-5554 shell getprop sys.boot_completed': { stdout: '1\n' },
  'adb -s emulator-5554 shell wm size': { stdout: 'Physical size: 1080x2400\n' },
  'adb -s emulator-5554 exec-out screencap -p': { bytes: makePng(4, 8) },
  'adb -s emulator-5554 shell input': {},
  'adb -s emulator-5554 emu kill': {},
  ...over,
});

interface Rig {
  svc: DeviceService;
  calls: string[];
  rows: (DeviceSession | null)[];
  frames: number[];
  screens: ScreensStore;
  spawned: { bin: string; args: string[] }[];
  sources: WindowSource[];
  access: { value: ScreenAccess };
  now: { value: number };
}

const rig = (
  routes: Record<string, Answer>,
  opts: {
    bins?: string[];
    remembered?: string | null;
    access?: ScreenAccess;
    sources?: WindowSource[];
    platform?: NodeJS.Platform;
  } = {},
): Rig => {
  const { exec, calls } = fakeExec(routes);
  const rows: (DeviceSession | null)[] = [];
  const frames: number[] = [];
  const spawned: { bin: string; args: string[] }[] = [];
  const sources = opts.sources ?? [];
  const access = { value: opts.access ?? 'denied' };
  const now = { value: 1_700_000_000_000 };
  const bins = opts.bins ?? ['xcrun', 'adb', 'emulator'];
  const screens = new ScreensStore(mkdtempSync(join(tmpdir(), 'styx-screens-')));
  const svc = new DeviceService({
    repos: {
      projects: { settings: () => ({ devDevice: opts.remembered ?? null }) },
    } as unknown as Repos,
    publisher: { devicesSet: (_id: string, s: DeviceSession | null) => rows.push(s) } as unknown as Publisher,
    clock: { now: () => now.value },
    screens,
    exec,
    which: async (bin) => (bins.includes(bin) ? `/opt/bin/${bin}` : null),
    platform: opts.platform ?? 'darwin',
    windowSources: async () => sources,
    screenAccess: () => access.value,
    openScreenAccess: async () => undefined,
    onFrame: (_id, seq) => frames.push(seq),
    frameMs: 500,
    spawn: (bin, args) => spawned.push({ bin, args }),
  });
  return { svc, calls, rows, frames, screens, spawned, sources, access, now };
};

const phases = (rows: (DeviceSession | null)[]) => rows.map((r) => (r === null ? null : r.phase));

afterEach(() => {
  vi.useRealTimers();
});

describe('DeviceService.tooling / list', () => {
  it('needs simctl to work and adb to run, and idb for iOS input', async () => {
    const a = rig({ ...iosRoutes(), ...androidRoutes() }, { bins: ['xcrun', 'adb', 'emulator', 'idb'] });
    expect(await a.svc.tooling()).toEqual({
      ios: true,
      android: true,
      iosInput: true,
      androidInput: true,
      screenAccess: 'denied',
    });
    // An `adb` on PATH that does not run (a broken SDK, or the e2e stand-in) is no SDK.
    const b = rig({ ...iosRoutes(), 'adb version': { exitCode: 127 } });
    expect(await b.svc.tooling()).toMatchObject({ ios: true, android: false, androidInput: false });
    // No Xcode: `xcrun simctl help` fails.
    const c = rig({ ...androidRoutes(), 'xcrun simctl help': { exitCode: 72 } });
    expect(await c.svc.tooling()).toMatchObject({ ios: false, android: true, iosInput: false });
    // Off a Mac nothing iOS is even looked for.
    const d = rig(androidRoutes(), { platform: 'linux' });
    expect(await d.svc.tooling()).toMatchObject({ ios: false, android: true });
    expect(d.calls.some((l) => l.startsWith('xcrun'))).toBe(false);
  });

  it('lists both platforms, booted first', async () => {
    const r = rig({
      ...iosRoutes(),
      ...androidRoutes({ 'adb devices -l': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' } }),
    });
    const list = await r.svc.list();
    expect(list.slice(0, 2).map((d) => d.id)).toEqual(['emulator-5554', 'A2']);
    expect((await r.svc.list('android')).map((d) => d.id)).toEqual(['emulator-5554', 'Pixel_8_API_35']);
  });
});

describe('DeviceService.boot (iOS)', () => {
  it('boots, waits for bootstatus, tolerates Simulator.app not opening, and learns the screen from a screenshot', async () => {
    const r = rig(iosRoutes());
    const out = await r.svc.boot(acme, 'ios', 'iPhone 17 Pro');
    expect(out).toEqual({ deviceId: 'A1', deviceName: 'iPhone 17 Pro' });
    expect(phases(r.rows)).toEqual(['booting', 'ready']);
    expect(r.rows[0]).toMatchObject({ mirror: 'none', input: false, screen: null, error: null });
    expect(r.rows[1]).toMatchObject({
      projectId: acme,
      platform: 'ios',
      deviceId: 'A1',
      deviceName: 'iPhone 17 Pro',
      screen: { width: 393, height: 852 },
      startedAt: 1_700_000_000_000,
    });
    const after = r.calls.indexOf('xcrun simctl boot A1');
    expect(r.calls.slice(after, after + 3)).toEqual([
      'xcrun simctl boot A1',
      'xcrun simctl bootstatus A1 -b',
      'open -a Simulator --args -CurrentDeviceUDID A1',
    ]);
    expect(r.calls[after + 3]).toMatch(/^xcrun simctl io A1 screenshot --type=png .*styx-shot-.*\.png$/);
    expect(r.svc.all()).toEqual([r.rows[1]]);
  });

  it('an already booted simulator (exit 149) is fine, and is what gets picked with nothing asked for', async () => {
    const r = rig(iosRoutes());
    expect(await r.svc.boot(acme, 'ios', null)).toEqual({ deviceId: 'A2', deviceName: 'iPhone 17' });
    expect(r.svc.get(acme)?.phase).toBe('ready');
  });

  it('the remembered device wins over the booted one; the asked-for name wins over both', async () => {
    const a = rig(iosRoutes(), { remembered: 'iPhone 17 Pro' });
    expect((await a.svc.boot(acme, 'ios', null)).deviceId).toBe('A1');
    const b = rig(iosRoutes(), { remembered: 'iPhone 17 Pro' });
    expect((await b.svc.boot(acme, 'ios', 'iPhone 17')).deviceId).toBe('A2');
  });

  it('no Xcode → cli-missing with the copy; no simulators → not-found', async () => {
    const a = rig(iosRoutes(), { bins: ['adb'] });
    await expect(a.svc.boot(acme, 'ios', null)).rejects.toMatchObject({
      code: 'cli-missing',
      message: copy.workspace.device.noToolingIos,
    });
    expect(a.rows).toEqual([]);
    const b = rig(iosRoutes({ 'xcrun simctl list devices available -j': { stdout: '{"devices":{}}' } }));
    await expect(b.svc.boot(acme, 'ios', null)).rejects.toMatchObject({
      code: 'not-found',
      message: 'No iOS simulators are set up on this machine.',
    });
    const c = rig(androidRoutes(), { bins: ['xcrun'] });
    await expect(c.svc.boot(acme, 'android', null)).rejects.toMatchObject({
      code: 'cli-missing',
      message: copy.workspace.device.noToolingAndroid,
    });
  });

  it('a boot that fails publishes `failed` with the tool error and throws it', async () => {
    const r = rig(iosRoutes({ 'xcrun simctl boot A1': { exitCode: 1, stderr: 'Invalid device: A1' } }));
    await expect(r.svc.boot(acme, 'ios', 'iPhone 17 Pro')).rejects.toMatchObject({
      code: 'internal',
      message: 'Invalid device: A1',
    });
    expect(phases(r.rows)).toEqual(['booting', 'failed']);
    expect(r.rows[1]).toMatchObject({ error: 'Invalid device: A1' });
    expect(await r.svc.mirror(acme)).toEqual({ mode: 'none', reason: 'Invalid device: A1' });
  });

  it('a second boot on the same device re-publishes and does nothing else; another device replaces it', async () => {
    const r = rig(iosRoutes());
    await r.svc.boot(acme, 'ios', 'iPhone 17 Pro');
    const boots = () => r.calls.filter((l) => l.startsWith('xcrun simctl boot ')).length;
    expect(boots()).toBe(1);
    await r.svc.boot(acme, 'ios', 'iPhone 17 Pro');
    expect(boots()).toBe(1);
    expect(phases(r.rows)).toEqual(['booting', 'ready', 'ready']);
    await r.svc.boot(acme, 'ios', 'iPhone 17');
    expect(boots()).toBe(2);
    expect(r.svc.all().map((s) => s.deviceId)).toEqual(['A2']);
  });
});

describe('DeviceService.boot (Android)', () => {
  it('starts the emulator detached, waits for its serial and for boot_completed, reads the screen', async () => {
    vi.useFakeTimers();
    let devicesCalls = 0;
    let getprops = 0;
    const r = rig({
      ...androidRoutes({
        'adb devices -l': () => ({
          stdout:
            ++devicesCalls <= 3
              ? 'List of devices attached\n'
              : 'List of devices attached\nemulator-5554\tdevice product:sdk_gphone64_arm64\n',
        }),
        'adb -s emulator-5554 emu avd name': { stdout: 'Pixel_8_API_35\nOK\n' },
        'adb -s emulator-5554 shell getprop sys.boot_completed': () => ({
          stdout: ++getprops < 2 ? '\n' : '1\n',
        }),
      }),
    });
    const p = r.svc.boot(acme, 'android', 'Pixel 8 API 35');
    await vi.advanceTimersByTimeAsync(10);
    expect(phases(r.rows)).toEqual(['booting']);
    expect(r.rows[0]).toMatchObject({ deviceId: 'Pixel_8_API_35', deviceName: 'Pixel 8 API 35' });
    expect(r.spawned).toEqual([
      { bin: '/opt/bin/emulator', args: ['-avd', 'Pixel_8_API_35', '-no-boot-anim'] },
    ]);
    // `adb devices` once for the listing and once before the spawn (what was already there), then one per 2 s poll.
    expect(devicesCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(devicesCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(devicesCalls).toBe(4);
    // Serial found; boot_completed was '' once, then '1' after the next 2 s.
    expect(getprops).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toEqual({ deviceId: 'emulator-5554', deviceName: 'Pixel 8 API 35' });
    expect(phases(r.rows)).toEqual(['booting', 'ready']);
    expect(r.rows[1]).toMatchObject({
      deviceId: 'emulator-5554',
      deviceName: 'Pixel 8 API 35',
      screen: { width: 1080, height: 2400 },
    });
    expect(r.calls).toContain('adb -s emulator-5554 emu avd name');
    expect(r.calls).toContain('adb -s emulator-5554 shell wm size');
  });

  it('a running emulator (serial) is not started again', async () => {
    const r = rig(
      androidRoutes({ 'adb devices -l': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' } }),
    );
    expect(await r.svc.boot(acme, 'android', null)).toEqual({
      deviceId: 'emulator-5554',
      deviceName: 'emulator-5554',
    });
    expect(r.spawned).toEqual([]);
    expect(r.svc.get(acme)?.screen).toEqual({ width: 1080, height: 2400 });
  });

  it('stop while the emulator is still coming up cancels the boot', async () => {
    vi.useFakeTimers();
    const r = rig(androidRoutes());
    const p = r.svc.boot(acme, 'android', 'Pixel_8_API_35');
    const rejected = expect(p).rejects.toMatchObject({
      code: 'internal',
      message: copy.workspace.device.stopped,
    });
    await vi.advanceTimersByTimeAsync(10);
    await r.svc.stop(acme, true);
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    // The row went with stop(); the cancelled boot publishes nothing more, and nothing was shut down.
    expect(phases(r.rows)).toEqual(['booting', null]);
    expect(r.calls.some((l) => l.includes('emu kill'))).toBe(false);
  });
});

describe('DeviceService.mirror', () => {
  const booted = async (opts: Parameters<typeof rig>[1] = {}, over: Record<string, Answer> = {}) => {
    const r = rig(iosRoutes(over), opts);
    await r.svc.boot(acme, 'ios', 'iPhone 17 Pro');
    r.rows.length = 0;
    return r;
  };

  it('an arm nobody collected within ARM_TTL_MS is void', async () => {
    const r = await booted({
      access: 'granted',
      sources: [{ id: 'window:2:0', name: 'iPhone 17 Pro – iOS 26.5' }],
    });
    expect(await r.svc.mirror(acme)).toEqual({ mode: 'window', reason: null });
    r.now.value += ARM_TTL_MS + 1;
    expect(r.svc.takeArmedSource()).toBeNull();
    // Armed again and collected in time: handed over.
    expect(await r.svc.mirror(acme)).toEqual({ mode: 'window', reason: null });
    r.now.value += ARM_TTL_MS - 1;
    expect(r.svc.takeArmedSource()).toEqual({ id: 'window:2:0', name: 'iPhone 17 Pro – iOS 26.5' });
  });

  it('arms the simulator window for getDisplayMedia when Screen Recording is granted and the window is there', async () => {
    const r = await booted({
      access: 'granted',
      sources: [
        { id: 'window:1:0', name: 'Styx' },
        { id: 'window:2:0', name: 'iPhone 17 Pro – iOS 26.5' },
      ],
    });
    expect(await r.svc.mirror(acme)).toEqual({ mode: 'window', reason: null });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ mirror: 'window', input: false });
    expect(r.svc.takeArmedSource()).toEqual({ id: 'window:2:0', name: 'iPhone 17 Pro – iOS 26.5' });
    // Once: the display-media handler gets it a single time.
    expect(r.svc.takeArmedSource()).toBeNull();
    // The heartbeat re-arms without re-publishing an unchanged row.
    await r.svc.mirror(acme);
    expect(r.rows).toHaveLength(1);
    expect(r.frames).toEqual([]);
  });

  it('falls back to screenshots when access is denied (and says so), polling while the pane keeps asking', async () => {
    vi.useFakeTimers();
    // Android: `screencap` answers in memory, so fake time alone drives the poller (the iOS path reads a file).
    let n = 0;
    const r = rig(
      androidRoutes({
        'adb devices -l': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
        'adb -s emulator-5554 exec-out screencap -p': () => ({ bytes: makePng(4, 8, [++n % 256, 0, 0]) }),
      }),
      { access: 'denied', sources: [{ id: 'window:4:0', name: 'Android Emulator - Pixel_8_API_35:5554' }] },
    );
    await r.svc.boot(acme, 'android', 'emulator-5554');
    r.rows.length = 0;
    expect(await r.svc.mirror(acme)).toEqual({
      mode: 'screenshots',
      reason: copy.workspace.device.screenAccess,
    });
    expect(r.rows[0]).toMatchObject({ mirror: 'screenshots', input: true });
    expect(r.svc.takeArmedSource()).toBeNull();
    // The first frame lands at once, then one every frameMs; each is the latest picture.
    await vi.advanceTimersByTimeAsync(0);
    expect(r.frames).toEqual([1]);
    expect(r.screens.frame(acme)).toEqual(makePng(4, 8, [1, 0, 0]));
    await vi.advanceTimersByTimeAsync(500);
    expect(r.frames).toEqual([1, 2]);
    expect(r.screens.frame(acme)).toEqual(makePng(4, 8, [2, 0, 0]));
    await vi.advanceTimersByTimeAsync(500);
    expect(r.frames).toEqual([1, 2, 3]);
    // A heartbeat at 30 s keeps it going past the 60 s mark from the first call…
    await vi.advanceTimersByTimeAsync(29_000);
    const before = r.frames.length;
    await r.svc.mirror(acme);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(r.frames.length).toBeGreaterThan(before + 60);
    // …and 60 s after the last one the poller stops by itself.
    await vi.advanceTimersByTimeAsync(30_000);
    const stopped = r.frames.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.frames.length).toBe(stopped);
    expect(r.rows).toHaveLength(1);
    // Asking again starts it over.
    await r.svc.mirror(acme);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.frames.length).toBe(stopped + 1);
  });

  it('polls when the window cannot be found even with access, without a reason', async () => {
    vi.useFakeTimers();
    const r = await booted({ access: 'granted', sources: [{ id: 'window:1:0', name: 'Styx' }] });
    expect(await r.svc.mirror(acme)).toEqual({ mode: 'screenshots', reason: null });
    await vi.waitFor(() => expect(r.frames).toEqual([1]));
    // Elsewhere (Windows / Linux) there is no permission to speak of.
    r.access.value = 'n/a';
    expect(await r.svc.mirror(acme)).toEqual({ mode: 'screenshots', reason: null });
  });

  it('never overlaps screenshots: a slow one delays the next by frameMs after it finishes', async () => {
    vi.useFakeTimers();
    let release: (() => void) | null = null;
    const r = rig(
      androidRoutes({
        'adb devices -l': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' },
        'adb -s emulator-5554 exec-out screencap -p': (_args, nth) =>
          nth === 2
            ? new Promise<Partial<DeviceExecResult>>((res) => {
                release = () => res({ bytes: makePng(4, 8) });
              })
            : { bytes: makePng(4, 8) },
      }),
    );
    await r.svc.boot(acme, 'android', 'emulator-5554');
    await r.svc.mirror(acme);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.frames).toEqual([1]);
    await vi.advanceTimersByTimeAsync(500);
    expect(release).not.toBeNull();
    // Stuck on the second shot: heartbeats and time do not start another.
    await r.svc.mirror(acme);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(r.calls.filter((l) => l.endsWith('screencap -p')).length).toBe(2);
    expect(r.frames).toEqual([1]);
    (release as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.frames).toEqual([1, 2]);
    // The next one comes frameMs after the slow one finished, not at the tick it missed.
    await vi.advanceTimersByTimeAsync(499);
    expect(r.frames).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.frames).toEqual([1, 2, 3]);
  });

  it('says why when nothing is ready', async () => {
    const r = rig(iosRoutes());
    expect(await r.svc.mirror(acme)).toEqual({ mode: 'none', reason: copy.workspace.device.empty });
  });
});

describe('DeviceService.input', () => {
  const android = async () => {
    const r = rig(
      androidRoutes({ 'adb devices -l': { stdout: 'List of devices attached\nemulator-5554\tdevice\n' } }),
    );
    await r.svc.boot(acme, 'android', 'emulator-5554');
    await r.svc.mirror(acme);
    r.calls.length = 0;
    return r;
  };
  const S = 'adb -s emulator-5554 shell input';

  it.each<[string, DeviceInput, string]>([
    ['tap', { kind: 'tap', x: 540, y: 1200 }, `${S} tap 540 1200`],
    [
      'swipe',
      { kind: 'swipe', x1: 100, y1: 1500, x2: 100, y2: 300, durationMs: 250 },
      `${S} swipe 100 1500 100 300 250`,
    ],
    ['enter', { kind: 'key', key: 'enter' }, `${S} keyevent KEYCODE_ENTER`],
    ['backspace', { kind: 'key', key: 'backspace' }, `${S} keyevent KEYCODE_DEL`],
    ['home', { kind: 'key', key: 'home' }, `${S} keyevent KEYCODE_HOME`],
    ['back', { kind: 'key', key: 'back' }, `${S} keyevent KEYCODE_BACK`],
    ['escape', { kind: 'key', key: 'escape' }, `${S} keyevent KEYCODE_ESCAPE`],
    ['text', { kind: 'text', text: 'hi there, you!' }, `${S} text hi%sthere,%syou!`],
  ])('android %s → exact adb argv', async (_name, event, argv) => {
    const r = await android();
    await r.svc.input(acme, event);
    expect(r.calls).toEqual([argv]);
  });

  it.each<[string, DeviceInput]>([
    ['shell metacharacters', { kind: 'text', text: 'hi; rm -rf /' }],
    ['quotes', { kind: 'text', text: `it's` }],
    ['dollar', { kind: 'text', text: '$HOME' }],
    ['newline', { kind: 'text', text: 'a\nb' }],
    ['unicode', { kind: 'text', text: 'héllo' }],
    ['tap off screen (x)', { kind: 'tap', x: 1080, y: 10 }],
    ['tap off screen (y)', { kind: 'tap', x: 10, y: 2400 }],
    ['swipe off screen', { kind: 'swipe', x1: 0, y1: 0, x2: 5000, y2: 0, durationMs: 100 }],
  ])('refuses %s before anything runs', async (_name, event) => {
    const r = await android();
    await expect(r.svc.input(acme, event)).rejects.toMatchObject({ code: 'invalid-input' });
    expect(r.calls).toEqual([]);
  });

  it('is refused when no input bridge exists (iOS without idb), with the copy', async () => {
    const r = rig(iosRoutes());
    await r.svc.boot(acme, 'ios', 'iPhone 17 Pro');
    await r.svc.mirror(acme);
    expect(r.svc.get(acme)?.input).toBe(false);
    r.calls.length = 0;
    await expect(r.svc.input(acme, { kind: 'tap', x: 1, y: 1 })).rejects.toMatchObject({
      code: 'cli-missing',
      message: copy.workspace.device.noInputIos,
    });
    expect(r.calls).toEqual([]);
    // No session at all, or one still booting, is not-found / invalid-transition.
    await expect(r.svc.input('proj:other' as ProjectId, { kind: 'tap', x: 1, y: 1 })).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('iOS through idb: pixels become points by the density idb reports; keys and buttons map', async () => {
    const r = rig(
      iosRoutes({
        'idb describe --udid A1 --json': {
          stdout: JSON.stringify({
            udid: 'A1',
            screen_dimensions: {
              width: 1179,
              height: 2556,
              density: 3,
              width_points: 393,
              height_points: 852,
            },
          }),
        },
        'idb ui': {},
      }),
      { bins: ['xcrun', 'idb'] },
    );
    await r.svc.boot(acme, 'ios', 'iPhone 17 Pro');
    await r.svc.mirror(acme);
    expect(r.svc.get(acme)?.input).toBe(true);
    r.calls.length = 0;
    await r.svc.input(acme, { kind: 'tap', x: 300, y: 600 });
    await r.svc.input(acme, { kind: 'swipe', x1: 30, y1: 600, x2: 30, y2: 90, durationMs: 500 });
    await r.svc.input(acme, { kind: 'key', key: 'enter' });
    await r.svc.input(acme, { kind: 'key', key: 'backspace' });
    await r.svc.input(acme, { kind: 'key', key: 'escape' });
    await r.svc.input(acme, { kind: 'key', key: 'back' });
    await r.svc.input(acme, { kind: 'key', key: 'home' });
    await r.svc.input(acme, { kind: 'text', text: 'hello world' });
    expect(r.calls).toEqual([
      'idb describe --udid A1 --json', // once per session
      'idb ui tap 100 200 --udid A1',
      'idb ui swipe 10 200 10 30 --duration 0.5 --udid A1',
      'idb ui key 40 --udid A1',
      'idb ui key 42 --udid A1',
      'idb ui key 41 --udid A1',
      'idb ui key 41 --udid A1',
      'idb ui button HOME --udid A1',
      'idb ui text hello world --udid A1',
    ]);
    // The screenshot's pixel bounds still apply to what the pane sends.
    await expect(r.svc.input(acme, { kind: 'tap', x: 393, y: 1 })).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(r.svc.input(acme, { kind: 'text', text: 'a"b' })).rejects.toMatchObject({
      code: 'invalid-input',
    });
  });
});

describe('DeviceService.focus / screenshot / stop', () => {
  it('focus opens Simulator.app on iOS and is refused on Android', async () => {
    const r = rig(iosRoutes());
    await r.svc.boot(acme, 'ios', 'iPhone 17 Pro');
    r.calls.length = 0;
    await r.svc.focus(acme);
    expect(r.calls).toEqual(['open -a Simulator']);
    const a = rig(androidRoutes({ 'adb devices -l': { stdout: 'emulator-5554\tdevice\n' } }));
    await a.svc.boot(acme, 'android', null);
    await expect(a.svc.focus(acme)).rejects.toMatchObject({
      code: 'cli-missing',
      message: copy.workspace.device.noInput,
    });
    await expect(r.svc.focus('proj:other' as ProjectId)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('screenshot returns a fresh PNG of a ready device and null otherwise', async () => {
    const r = rig(iosRoutes());
    expect(await r.svc.screenshot(acme)).toBeNull();
    await r.svc.boot(acme, 'ios', 'iPhone 17 Pro');
    expect(await r.svc.screenshot(acme)).toEqual(shot);
    const a = rig(androidRoutes({ 'adb devices -l': { stdout: 'emulator-5554\tdevice\n' } }));
    await a.svc.boot(acme, 'android', null);
    expect(await a.svc.screenshot(acme)).toEqual(makePng(4, 8));
    expect(a.calls.at(-1)).toBe('adb -s emulator-5554 exec-out screencap -p');
    const failing = rig(iosRoutes({ 'xcrun simctl io': { exitCode: 1 } }));
    await failing.svc.boot(acme, 'ios', 'iPhone 17 Pro');
    expect(await failing.svc.screenshot(acme)).toBeNull();
  });

  it('stop drops the row, the frame and the armed window; with shutdown it also shuts the simulator down', async () => {
    vi.useFakeTimers();
    const r = rig(iosRoutes(), {
      access: 'granted',
      sources: [{ id: 'w', name: 'iPhone 17 Pro – iOS 26.5' }],
    });
    await r.svc.boot(acme, 'ios', 'iPhone 17 Pro');
    await r.svc.mirror(acme);
    r.calls.length = 0;
    await r.svc.stop(acme, false);
    expect(r.rows.at(-1)).toBeNull();
    expect(r.svc.all()).toEqual([]);
    expect(r.svc.takeArmedSource()).toBeNull();
    expect(r.calls).toEqual([]);
    await r.svc.stop(acme, true); // nothing left: a no-op
    expect(r.calls).toEqual([]);

    // Screenshots mode, then a shutdown stop: the poller ends and the frame goes.
    r.access.value = 'denied';
    await r.svc.boot(acme, 'ios', 'iPhone 17 Pro');
    await r.svc.mirror(acme);
    await vi.waitFor(() => expect(r.screens.frame(acme)).not.toBeNull());
    r.calls.length = 0;
    const n = r.frames.length;
    await r.svc.stop(acme, true);
    expect(r.calls).toEqual(['xcrun simctl shutdown A1']);
    expect(r.screens.frame(acme)).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.frames.length).toBe(n);
    expect(r.rows.at(-1)).toBeNull();

    const a = rig(androidRoutes({ 'adb devices -l': { stdout: 'emulator-5554\tdevice\n' } }));
    await a.svc.boot(acme, 'android', null);
    a.calls.length = 0;
    await a.svc.stop(acme, true);
    expect(a.calls).toEqual(['adb -s emulator-5554 emu kill']);
  });

  it('shutdown() stops every poller and leaves the simulators up', async () => {
    vi.useFakeTimers();
    const r = rig(iosRoutes());
    await r.svc.boot(acme, 'ios', 'iPhone 17 Pro');
    await r.svc.mirror(acme);
    await vi.waitFor(() => expect(r.frames.length).toBeGreaterThan(0));
    r.calls.length = 0;
    r.svc.shutdown();
    const n = r.frames.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.frames.length).toBe(n);
    expect(r.calls).toEqual([]);
    expect(r.svc.all()).toHaveLength(1);
  });
});
