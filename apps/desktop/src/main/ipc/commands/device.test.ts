import {
  commandResultSchema,
  commands,
  fixtures,
  type DeviceSession,
  type DevRun,
  type ProjectId,
} from '@styx/core';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../clock';
import { buildContainer, type WindowsPort } from '../../container';
import { migrate } from '../../db/migrate';
import { loadFixture, seed } from '../../db/seed';
import { FakeCliRunner } from '../../providers/cli-runner';
import { MemoryVault } from '../../services/credential-vault';
import type { DeviceExec, DeviceExecResult, WindowSource } from '../../services/device-service';
import { FakeMfaProvider } from '../../services/mfa-service';
import { PtyService } from '../../services/pty-service';
import { FakeWindow } from '../../test-support';

class FakePty extends PtyService {
  private readonly live = new Set<string>();
  readonly killed: string[] = [];
  constructor() {
    super('darwin');
  }
  override defaultShell(): string {
    return '/bin/zsh';
  }
  override async resolveLoginPath(): Promise<string> {
    return '/usr/bin';
  }
  override async spawn(opts: { id: string }) {
    this.live.add(opts.id);
    return { pid: 1 };
  }
  override write(): void {}
  override resize(): void {}
  override kill(id: string): void {
    this.killed.push(id);
    if (!this.live.delete(id)) return;
    this.emit('exit', id, 0, undefined);
  }
  override killGroup(id: string): void {
    this.kill(id);
  }
  override has(id: string): boolean {
    return this.live.has(id);
  }
  override killAll(): void {
    for (const id of [...this.live]) this.kill(id);
  }
  data(id: string, chunk: string): void {
    this.emit('data', id, chunk);
  }
}

const acme = fixtures.ids.project.acmeShop as ProjectId;

/** A PNG header is all `pngSize` reads; the IPC layer never decodes the picture. */
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from('IHDR', 'latin1'),
  Buffer.from([0, 0, 0x01, 0x89, 0, 0, 0x03, 0x54, 8, 2, 0, 0, 0]),
]);

const simctl = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: 'FAKE-17PRO', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true },
    ],
  },
});

/** A Mac with Xcode and no Android SDK, faked at the container's `deviceExec` / `deviceWhich` seams. */
const setup = (opts: { sources?: WindowSource[]; access?: 'granted' | 'denied'; idb?: boolean } = {}) => {
  const calls: string[] = [];
  const exec: DeviceExec = async (bin, args) => {
    const line = `${bin} ${args.join(' ')}`;
    calls.push(line);
    const ok = (r: Partial<DeviceExecResult> = {}) => ({ stdout: '', stderr: '', exitCode: 0, ...r });
    if (line === 'xcrun simctl help') return ok();
    if (line === 'xcrun simctl list devices available -j') return ok({ stdout: simctl });
    if (line === 'xcrun simctl boot FAKE-17PRO') return ok();
    if (line === 'xcrun simctl bootstatus FAKE-17PRO -b') return ok();
    if (line.startsWith('open -a Simulator')) return ok();
    if (line.startsWith('xcrun simctl io FAKE-17PRO screenshot --type=png ')) {
      writeFileSync(args[args.length - 1] ?? '', png);
      return ok();
    }
    if (line === 'xcrun simctl shutdown FAKE-17PRO') return ok();
    if (line.startsWith('idb ')) return ok({ stdout: '{}' });
    return ok({ exitCode: 2, stderr: `fake: ${line}` });
  };
  const db = new Database(':memory:');
  migrate(db);
  const clock = new ManualClock(fixtures.DEMO_NOW);
  const pty = new FakePty();
  const userData = mkdtempSync(join(tmpdir(), 'styx-device-ipc-'));
  let opened = 0;
  const windows: WindowsPort = {
    popoutSessionIds: () => [],
    openPopout: () => undefined,
    dockPopout: () => undefined,
    openDock: () => undefined,
    closeDock: () => undefined,
    dockOpen: () => false,
    control: () => undefined,
    focusMain: () => undefined,
  };
  const app = buildContainer({
    db,
    clock,
    vault: new MemoryVault(),
    mfaProvider: new FakeMfaProvider('ok'),
    runtime: {
      userData,
      platform: 'darwin',
      shimDir: join(userData, 'bin'),
      cliPath: join(userData, 'styx.js'),
      exePath: process.execPath,
      brokerEndpoint: join(userData, 'broker.sock'),
      resourcesDir: join(userData, 'resources'),
      rendererOrigins: ['file://'],
    },
    windows,
    notifications: null,
    openExternal: async () => undefined,
    openInIde: async () => undefined,
    pty,
    cli: new FakeCliRunner(),
    redetectClis: false,
    deviceExec: exec,
    deviceWhich: async (bin) =>
      bin === 'xcrun' || bin === 'open' || (bin === 'idb' && opts.idb === true) ? `/usr/bin/${bin}` : null,
    deviceHooks: {
      windowSources: async () => opts.sources ?? [],
      screenAccess: () => opts.access ?? 'denied',
      openScreenAccess: async () => {
        opened++;
      },
    },
  });
  seed(app.repos, loadFixture('demo'));
  const win = new FakeWindow(1);
  app.publisher.register(win);
  const sender = { senderId: 1, frameUrl: 'file:///index.html' };
  // The run writes `.styx/project.json` into the project folder: a temp dir, not the fixture's literal path.
  const project = app.repos.projects.get(acme);
  if (!project) throw new Error('fixture project');
  app.repos.projects.upsert({ ...project, path: mkdtempSync(join(tmpdir(), 'styx-device-proj-')) }, {});
  const deltas = () => {
    app.publisher.flush();
    return win.batches().flatMap((b) => b.deltas);
  };
  const deviceRows = () =>
    deltas()
      .filter(
        (d): d is { op: 'devices.set'; projectId: string; device: DeviceSession | null } =>
          d.op === 'devices.set',
      )
      .map((d) => d.device);
  const runRows = () =>
    deltas()
      .filter((d): d is { op: 'runs.set'; projectId: string; run: DevRun | null } => d.op === 'runs.set')
      .map((d) => d.run);
  return { app, sender, win, pty, calls, deviceRows, runRows, deltas, opened: () => opened };
};

describe('device.* commands', () => {
  it('device.tooling reports what the machine has, contract-valid', async () => {
    const { app, sender } = setup();
    const r = await app.bus.dispatch(sender, 'device.tooling', {});
    expect(commandResultSchema('device.tooling').safeParse(r).success).toBe(true);
    expect(r).toEqual({
      ok: true,
      value: { ios: true, android: false, iosInput: false, androidInput: false, screenAccess: 'denied' },
    });
  });

  it('device.list lists simulators, filtered by platform', async () => {
    const { app, sender } = setup();
    const all = await app.bus.dispatch(sender, 'device.list', {});
    expect(commandResultSchema('device.list').safeParse(all).success).toBe(true);
    expect(all).toEqual({
      ok: true,
      value: {
        devices: [
          {
            platform: 'ios',
            id: 'FAKE-17PRO',
            name: 'iPhone 17 Pro',
            runtime: 'iOS 26.5',
            state: 'shutdown',
          },
        ],
      },
    });
    expect(await app.bus.dispatch(sender, 'device.list', { platform: 'android' })).toEqual({
      ok: true,
      value: { devices: [] },
    });
    expect((await app.bus.dispatch(sender, 'device.list', { platform: 'web' })).ok).toBe(false);
  });

  it('device.boot → devices.set booting then ready; device.stop → null (and shuts down when asked)', async () => {
    const { app, sender, calls, deviceRows } = setup();
    const r = await app.bus.dispatch(sender, 'device.boot', { projectId: acme, platform: 'ios' });
    expect(commandResultSchema('device.boot').safeParse(r).success).toBe(true);
    expect(r).toEqual({ ok: true, value: { deviceId: 'FAKE-17PRO', deviceName: 'iPhone 17 Pro' } });
    expect(deviceRows().map((d) => d?.phase)).toEqual(['booting', 'ready']);
    expect(deviceRows().at(-1)).toMatchObject({ screen: { width: 393, height: 852 }, mirror: 'none' });
    expect(app.publisher.snapshot().devices).toEqual([deviceRows().at(-1)]);

    calls.length = 0;
    const stop = await app.bus.dispatch(sender, 'device.stop', { projectId: acme, shutdown: true });
    expect(stop).toEqual({ ok: true, value: {} });
    expect(deviceRows().at(-1)).toBeNull();
    expect(calls).toEqual(['xcrun simctl shutdown FAKE-17PRO']);
    expect(app.publisher.snapshot().devices).toEqual([]);
    // `shutdown` defaults to false: a bare stop only forgets.
    await app.bus.dispatch(sender, 'device.boot', {
      projectId: acme,
      platform: 'ios',
      device: 'iPhone 17 Pro',
    });
    calls.length = 0;
    expect(await app.bus.dispatch(sender, 'device.stop', { projectId: acme })).toEqual({
      ok: true,
      value: {},
    });
    expect(calls).toEqual([]);
  });

  it('device.boot refuses a bad platform / device name before the service runs anything', async () => {
    const { app, sender, calls } = setup();
    expect((await app.bus.dispatch(sender, 'device.boot', { projectId: acme, platform: 'web' })).ok).toBe(
      false,
    );
    expect(
      (await app.bus.dispatch(sender, 'device.boot', { projectId: acme, platform: 'ios', device: '' })).ok,
    ).toBe(false);
    expect(calls).toEqual([]);
    expect(app.devices.all()).toEqual([]);
  });

  it('device.mirror → screenshots with the Screen Recording reason; frames arrive as device.frame events', async () => {
    const { app, sender, win, deviceRows } = setup();
    await app.bus.dispatch(sender, 'device.boot', { projectId: acme, platform: 'ios' });
    const r = await app.bus.dispatch(sender, 'device.mirror', { projectId: acme });
    expect(commandResultSchema('device.mirror').safeParse(r).success).toBe(true);
    expect(r).toEqual({
      ok: true,
      value: {
        mode: 'screenshots',
        reason:
          'Styx needs Screen Recording to mirror the simulator live. It falls back to screenshots until then.',
      },
    });
    expect(deviceRows().at(-1)).toMatchObject({ mirror: 'screenshots', input: false });
    await expect.poll(() => win.events('device.frame').length).toBeGreaterThan(0);
    expect(win.events('device.frame')[0]).toEqual({ projectId: acme, seq: 1 });
    expect(await app.screens.resolve(`styx-device://frame/${acme}?seq=1`)).toEqual(png);
    await app.bus.dispatch(sender, 'device.stop', { projectId: acme });
    expect(await app.screens.resolve(`styx-device://frame/${acme}?seq=1`)).toBeNull();
    // Nothing mirrored: a reason, not an error.
    expect(await app.bus.dispatch(sender, 'device.mirror', { projectId: acme })).toEqual({
      ok: true,
      value: { mode: 'none', reason: 'Run locally to build the app and mirror the simulator here.' },
    });
  });

  it('device.mirror → window when access is granted and the simulator window is capturable', async () => {
    const { app, sender } = setup({
      access: 'granted',
      sources: [{ id: 'window:9:0', name: 'iPhone 17 Pro – iOS 26.5' }],
    });
    await app.bus.dispatch(sender, 'device.boot', { projectId: acme, platform: 'ios' });
    expect(await app.bus.dispatch(sender, 'device.mirror', { projectId: acme })).toEqual({
      ok: true,
      value: { mode: 'window', reason: null },
    });
    expect(app.devices.takeArmedSource()).toEqual({ id: 'window:9:0', name: 'iPhone 17 Pro – iOS 26.5' });
    expect(app.devices.takeArmedSource()).toBeNull();
  });

  it('device.input is refused without an input bridge, validated before the service, and forwarded with idb', async () => {
    const a = setup();
    await a.app.bus.dispatch(a.sender, 'device.boot', { projectId: acme, platform: 'ios' });
    await a.app.bus.dispatch(a.sender, 'device.mirror', { projectId: acme });
    const refused = await a.app.bus.dispatch(a.sender, 'device.input', {
      projectId: acme,
      event: { kind: 'tap', x: 10, y: 10 },
    });
    expect(commandResultSchema('device.input').safeParse(refused).success).toBe(true);
    expect(refused).toMatchObject({ ok: false, error: { code: 'cli-missing' } });
    a.calls.length = 0;
    const bad = await a.app.bus.dispatch(a.sender, 'device.input', {
      projectId: acme,
      event: { kind: 'tap', x: -1, y: 10 },
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    expect(a.calls).toEqual([]);

    const b = setup({ idb: true });
    await b.app.bus.dispatch(b.sender, 'device.boot', { projectId: acme, platform: 'ios' });
    await b.app.bus.dispatch(b.sender, 'device.mirror', { projectId: acme });
    b.calls.length = 0;
    const ok = await b.app.bus.dispatch(b.sender, 'device.input', {
      projectId: acme,
      event: { kind: 'text', text: 'hello' },
    });
    expect(ok).toEqual({ ok: true, value: {} });
    expect(b.calls).toEqual(['idb describe --udid FAKE-17PRO --json', 'idb ui text hello --udid FAKE-17PRO']);
    const meta = await b.app.bus.dispatch(b.sender, 'device.input', {
      projectId: acme,
      event: { kind: 'text', text: 'rm -rf / ; $(x)' },
    });
    expect(meta).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    expect(b.calls).toHaveLength(2);
  });

  it('device.focus opens Simulator.app; device.openScreenAccess opens the privacy pane', async () => {
    const { app, sender, calls, opened } = setup();
    expect(await app.bus.dispatch(sender, 'device.focus', { projectId: acme })).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    await app.bus.dispatch(sender, 'device.boot', { projectId: acme, platform: 'ios' });
    calls.length = 0;
    const r = await app.bus.dispatch(sender, 'device.focus', { projectId: acme });
    expect(commandResultSchema('device.focus').safeParse(r).success).toBe(true);
    expect(r).toEqual({ ok: true, value: {} });
    expect(calls).toEqual(['open -a Simulator']);
    expect(await app.bus.dispatch(sender, 'device.openScreenAccess', {})).toEqual({ ok: true, value: {} });
    expect(opened()).toBe(1);
  });

  it('run.start on ios boots the device first, then runs, and never adopts a URL the process prints', async () => {
    const { app, sender, pty, deltas, runRows } = setup();
    const r = await app.bus.dispatch(sender, 'run.start', {
      projectId: acme,
      command: 'npx expo run:ios',
      platform: 'ios',
    });
    expect(commandResultSchema('run.start').safeParse(r).success).toBe(true);
    if (!r.ok) throw new Error('start failed');
    expect(commands['run.start'].output.safeParse(r.value).success).toBe(true);
    const ops = deltas()
      .filter((d) => d.op === 'devices.set' || d.op === 'runs.set')
      .map((d) =>
        d.op === 'devices.set'
          ? `devices:${(d as unknown as { device: DeviceSession }).device.phase}`
          : `runs:${(d as unknown as { run: DevRun }).run.phase}`,
      );
    expect(ops).toEqual(['devices:booting', 'devices:ready', 'runs:starting', 'runs:running']);
    expect(runRows().at(-1)).toMatchObject({ platform: 'ios', url: null });
    // Metro prints its own address; that is not the app.
    pty.data(r.value.terminalId, 'Metro waiting on http://localhost:8081\n');
    await new Promise((res) => setTimeout(res, 10));
    expect(runRows().at(-1)?.url).toBeNull();
    expect(app.repos.projects.settings(acme).devUrl).toBeUndefined();
  });

  it('run.start on ios fails when no simulator can be booted, and starts nothing', async () => {
    const { app, sender, pty, runRows } = setup();
    const r = await app.bus.dispatch(sender, 'run.start', {
      projectId: acme,
      command: 'npx expo run:android',
      platform: 'android',
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'cli-missing' } });
    expect(runRows()).toEqual([]);
    expect(pty.killed).toEqual([]);
    expect(app.runs.all()).toEqual([]);
  });
});
