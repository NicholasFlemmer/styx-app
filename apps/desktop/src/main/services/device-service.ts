import {
  copy,
  fill,
  type DeviceInput,
  type DevicePlatform,
  type DeviceSession,
  type DeviceSummary,
  type ProjectId,
} from '@styx/core';
import { execa } from 'execa';
import { spawn as nodeSpawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { CommandError, fail } from '../ipc/bus';
import type { Publisher } from '../store/publisher';
import { logger, redact } from './logger';
import type { ScreensStore } from './screens-store';

export interface DeviceExecOptions {
  timeoutMs?: number;
  cwd?: string;
  /** Stdout is bytes, not text (`adb exec-out screencap -p` prints a PNG): it comes back as `bytes`. */
  binary?: true;
}

export interface DeviceExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Stdout as bytes, only when `binary` was asked for. */
  bytes?: Buffer;
}

/** Runs a tool and returns what it printed; never throws for a non-zero exit (`exitCode` says). */
export type DeviceExec = (bin: string, args: string[], opts?: DeviceExecOptions) => Promise<DeviceExecResult>;

/** A window the OS can capture (Electron `desktopCapturer` source): title and the id `getDisplayMedia` needs. */
export interface WindowSource {
  id: string;
  name: string;
}

export type ScreenAccess = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown' | 'n/a';

export interface DeviceServiceDeps {
  repos: Repos;
  publisher: Publisher;
  clock: Clock;
  screens: ScreensStore;
  exec: DeviceExec;
  /** Is `bin` on the PATH Styx runs tools with? */
  which: (bin: string) => Promise<string | null>;
  platform: NodeJS.Platform;
  /** Capturable windows right now (Electron `desktopCapturer.getSources({ types: ['window'] })`); empty in tests. */
  windowSources: () => Promise<WindowSource[]>;
  /** macOS Screen Recording permission (`systemPreferences.getMediaAccessStatus('screen')`); `n/a` elsewhere. */
  screenAccess: () => ScreenAccess;
  /** Opens the OS's Screen Recording privacy pane (no-op off macOS). */
  openScreenAccess: () => Promise<void>;
  /** Emits `device.frame` for screenshots-mode mirroring. */
  onFrame: (projectId: ProjectId, seq: number) => void;
  /** Screenshot polling period in screenshots mode. */
  frameMs?: number;
  /** Starts a process Styx never waits for (the Android emulator); detached and unreferenced by default. */
  spawn?: (bin: string, args: string[]) => void;
}

export interface DeviceTooling {
  ios: boolean;
  android: boolean;
  iosInput: boolean;
  androidInput: boolean;
  screenAccess: ScreenAccess;
}

/** Only these ever reach argv as a device id: a simulator UDID, an AVD name, or an emulator serial. */
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,80}$/;
/** `adb shell input text` and `idb ui text` re-parse on the device: nothing outside this set is ever sent. */
const TEXT_OK = /^[A-Za-z0-9 .,!?@#_-]+$/;
const BOOT_TIMEOUT_MS = 180_000;
const ANDROID_POLL_MS = 2000;
/** Screenshots keep flowing this long after the last `mirror()` (the pane calls it again as a heartbeat). */
const WATCH_MS = 60_000;
const DEFAULT_FRAME_MS = 500;
const ANDROID_KEYS: Record<Extract<DeviceInput, { kind: 'key' }>['key'], string> = {
  enter: 'KEYCODE_ENTER',
  backspace: 'KEYCODE_DEL',
  home: 'KEYCODE_HOME',
  back: 'KEYCODE_BACK',
  escape: 'KEYCODE_ESCAPE',
};
/** HID usage ids idb takes (`idb ui key`): enter, backspace, escape. Home is a hardware button; iOS has no back key. */
const IDB_KEYS = { enter: '40', backspace: '42', escape: '41' } as const;

/**
 * The PATH device tools run with: the process's own first (an e2e run shadows `xcrun` / `open` in front of
 * /usr/bin), then the login shell's (where the Android SDK and idb usually live, and the only one a packaged app
 * launched from Finder would otherwise miss).
 */
const toolPath = async (loginPath: () => Promise<string>, platform: NodeJS.Platform): Promise<string> => {
  const login = await loginPath().catch(() => '');
  const sep = platform === 'win32' ? ';' : ':';
  return [process.env['PATH'] ?? '', login].filter((p) => p !== '').join(sep);
};

/** The default runner: the tool on the PATH (Xcode's `xcrun`, the SDK's `adb`), no shell in between. */
export const execaDeviceExec =
  (loginPath: () => Promise<string>, platform: NodeJS.Platform = process.platform): DeviceExec =>
  async (bin, args, opts = {}) => {
    const PATH = await toolPath(loginPath, platform);
    const common = {
      reject: false as const,
      timeout: opts.timeoutMs ?? 30_000,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: { ...process.env, PATH, NO_COLOR: '1' },
    };
    if (opts.binary === true) {
      const r = await execa(bin, args, { ...common, encoding: 'buffer' });
      return {
        stdout: '',
        stderr: Buffer.from(r.stderr ?? []).toString('utf8'),
        exitCode: r.exitCode ?? 1,
        bytes: Buffer.from(r.stdout ?? []),
      };
    }
    const r = await execa(bin, args, { ...common, encoding: 'utf8' });
    return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: r.exitCode ?? 1 };
  };

/** `which`/`where` on the tool PATH: the first hit, or null. */
export const execaWhich =
  (loginPath: () => Promise<string>, platform: NodeJS.Platform) =>
  async (bin: string): Promise<string | null> => {
    if (!/^[A-Za-z0-9._-]+$/.test(bin)) return null;
    const PATH = await toolPath(loginPath, platform);
    const r = await execa(platform === 'win32' ? 'where' : 'which', [bin], {
      reject: false,
      timeout: 5000,
      env: { ...process.env, PATH },
      encoding: 'utf8',
    });
    const first = String(r.stdout ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '');
    return r.exitCode === 0 && first !== undefined ? first : null;
  };

/** The emulator outlives Styx's interest in it: detached, its own process group, never waited for. */
const defaultSpawn = (bin: string, args: string[]): void => {
  const child = nodeSpawn(bin, args, { detached: true, stdio: 'ignore' });
  child.on('error', (e: Error) => logger.warn('device: emulator did not start', { error: e.message }));
  child.unref();
};

// --- pure parsers (unit-tested; the service is the only caller) -----------------------------------------------

/** `xcrun simctl list devices available -j` → summaries, runtime names humanised (`iOS 26.5`). */
export const parseSimctlList = (json: string): DeviceSummary[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const devices = (parsed as { devices?: Record<string, unknown[]> })?.devices ?? {};
  const out: DeviceSummary[] = [];
  for (const [runtimeId, list] of Object.entries(devices)) {
    if (!Array.isArray(list)) continue;
    const runtime = humaniseRuntime(runtimeId);
    for (const raw of list) {
      const d = raw as { udid?: string; name?: string; state?: string; isAvailable?: boolean };
      if (typeof d.udid !== 'string' || typeof d.name !== 'string') continue;
      if (d.isAvailable === false) continue;
      const state = d.state === 'Booted' ? 'booted' : d.state === 'Booting' ? 'booting' : 'shutdown';
      out.push({ platform: 'ios', id: d.udid, name: d.name, runtime, state });
    }
  }
  return sortDevices(out);
};

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-5` → `iOS 26.5`; anything else is passed through. */
export const humaniseRuntime = (id: string): string | null => {
  const m = /SimRuntime\.([A-Za-z]+)-(\d+)(?:-(\d+))?(?:-(\d+))?$/.exec(id);
  if (!m) return id === '' ? null : id;
  return `${m[1]} ${[m[2], m[3], m[4]].filter((p) => p !== undefined).join('.')}`;
};

/** `adb devices -l` → the emulator serials it lists and whether each is up (`device`) or still `offline`. */
export const parseAdbSerials = (adbDevices: string): { serial: string; state: 'device' | 'offline' }[] => {
  const out: { serial: string; state: 'device' | 'offline' }[] = [];
  for (const line of adbDevices.split('\n')) {
    const m = /^(emulator-\d+)\s+(device|offline)\b/.exec(line.trim());
    if (m?.[1] !== undefined) out.push({ serial: m[1], state: m[2] === 'device' ? 'device' : 'offline' });
  }
  return out;
};

/** `emulator -list-avds` (one name per line) plus `adb devices -l` (running emulators) → summaries. */
export const parseAndroidDevices = (avds: string, adbDevices: string): DeviceSummary[] => {
  const out: DeviceSummary[] = [];
  for (const raw of avds.split('\n')) {
    const name = raw.trim();
    if (name === '' || /^INFO\s*\|/.test(name)) continue;
    out.push({
      platform: 'android',
      id: name,
      name: name.replace(/_/g, ' '),
      runtime: null,
      state: 'shutdown',
    });
  }
  // `adb devices -l` does not name the AVD; the `emu avd name` lookup is the service's job. The serial is kept
  // under its own key so a running emulator still lists when no AVD name could be matched.
  for (const { serial, state } of parseAdbSerials(adbDevices))
    out.push({
      platform: 'android',
      id: serial,
      name: serial,
      runtime: null,
      state: state === 'device' ? 'booted' : 'booting',
    });
  return sortDevices(out);
};

/** `adb shell wm size` → `Physical size: 1080x2400` (an `Override size:` line, when present, is what is shown). */
export const parseWmSize = (text: string): { width: number; height: number } | null => {
  const m = /Override size:\s*(\d+)x(\d+)/.exec(text) ?? /Physical size:\s*(\d+)x(\d+)/.exec(text);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
};

/** Width and height from a PNG's IHDR (always the first chunk: bytes 16..24, big-endian); null for anything else. */
export const pngSize = (png: Buffer): { width: number; height: number } | null => {
  if (png.length < 24 || png[0] !== 0x89 || png.toString('latin1', 1, 4) !== 'PNG') return null;
  if (png.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
};

/** Booted first, then booting, then by name — the order the picker shows. */
export const sortDevices = (list: DeviceSummary[]): DeviceSummary[] => {
  const rank = { booted: 0, booting: 1, shutdown: 2 } as const;
  return [...list].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
};

/**
 * Picks the device to boot: the name asked for (exact, then case-insensitive prefix), else the project's
 * remembered name, else the first booted one, else the first iPhone (iOS) / first AVD (Android), else the first.
 */
export const pickDevice = (
  list: readonly DeviceSummary[],
  wanted: string | null,
  remembered: string | null,
): DeviceSummary | null => {
  const byName = (name: string | null) => {
    if (name === null) return undefined;
    const exact = list.find((d) => d.name === name || d.id === name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    return list.find((d) => d.name.toLowerCase().startsWith(lower));
  };
  return (
    byName(wanted) ??
    byName(remembered) ??
    list.find((d) => d.state === 'booted') ??
    list.find((d) => d.platform === 'ios' && /^iPhone/i.test(d.name)) ??
    list[0] ??
    null
  );
};

/**
 * The simulator's window among the capturable ones: Simulator.app titles its windows `<device name> – <runtime>`
 * (an en dash; older versions use `—` or `-`), the Android Emulator `Android Emulator - <avd>:<port>`.
 */
export const matchWindowSource = (
  sources: readonly WindowSource[],
  device: Pick<DeviceSummary, 'platform' | 'name' | 'id'> & { runtime?: string | null },
): WindowSource | null => {
  const name = device.name.toLowerCase();
  const avd = device.id.toLowerCase();
  const runtime = device.runtime?.toLowerCase() ?? null;
  const matches: WindowSource[] = [];
  for (const s of sources) {
    const title = s.name.toLowerCase();
    if (device.platform === 'ios') {
      // The separator must follow the name at once (`iPhone 17` is not `iPhone 17 Pro – iOS 26.5`), and when the
      // runtime is known it must follow the separator: a browser tab titled `iPhone 17 Pro - Apple` is not it.
      if (!title.startsWith(name)) continue;
      const m = /^\s*[–—-]\s*(.*)$/.exec(title.slice(name.length));
      if (m === null) continue;
      if (runtime !== null && !(m[1] ?? '').startsWith(runtime)) continue;
      matches.push(s);
    } else if (title.startsWith('android emulator') && (title.includes(avd) || title.includes(name))) {
      matches.push(s);
    }
  }
  // Two candidates means the title rule is not telling them apart: better no picture than the wrong window.
  return matches.length === 1 ? (matches[0] ?? null) : null;
};

/** How long an armed window waits for the renderer's `getDisplayMedia`; after that the arm is void. */
export const ARM_TTL_MS = 10_000;

/** `adb shell input text` takes `%s` for a space; everything else allowed by `TEXT_OK` passes through as is. */
export const androidText = (text: string): string => text.replace(/ /g, '%s');

/** A boot in progress; `cancelled` flips when the session is stopped or replaced, and the boot gives up. */
interface BootToken {
  cancelled: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/** What a tool said when it failed, redacted: it is shown to the user and travels in a store delta. */
const errorText = (r: DeviceExecResult, what: string): string =>
  redact(
    r.stderr.trim() !== ''
      ? r.stderr.trim()
      : r.stdout.trim() !== ''
        ? r.stdout.trim()
        : `${what} exited ${r.exitCode}`,
  );

/**
 * The simulator / emulator the design window mirrors (owner request: the design tab as a simulator that shows
 * the app as it is being built). One device session per project, main-owned, in memory like a run.
 *
 * Tooling is the platform's own: `xcrun simctl` for iOS, `adb` / `emulator` for Android, found on the same PATH
 * the shims use. Mirroring prefers a live capture of the simulator's own window (Electron's display-media
 * handler hands the renderer that one window, nothing else) and falls back to polled screenshots
 * (`simctl io … screenshot`, `adb exec-out screencap`) when the window is not capturable — Screen Recording not
 * granted, the window not found, or a headless emulator. Input goes through `adb shell input` on Android and
 * `idb` on iOS when installed; otherwise the pane offers to bring the simulator's window forward.
 */
export class DeviceService {
  private readonly sessions = new Map<string, DeviceSession>();
  /** The next screenshot tick per project (a chain of timeouts, so ticks never overlap). */
  private readonly pollers = new Map<string, NodeJS.Timeout>();
  /** Stops the poller `WATCH_MS` after the last `mirror()`. */
  private readonly watchers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();
  private readonly boots = new Map<string, BootToken>();
  /** iOS: idb speaks points, screenshots are pixels; the scale from `idb describe`, learned once per session. */
  private readonly densities = new Map<string, number>();
  /** The window source a `getDisplayMedia` request from the renderer should get, armed by `mirror()`. */
  private armed: WindowSource | null = null;
  private armedFor: string | null = null;
  private armedAt = 0;
  /** The runtime of each project's device (`iOS 26.5`), for the window-title match. */
  private readonly runtimes = new Map<string, string | null>();

  constructor(private readonly deps: DeviceServiceDeps) {}

  /** Rows for the snapshot. */
  all(): DeviceSession[] {
    return [...this.sessions.values()];
  }

  get(projectId: ProjectId): DeviceSession | null {
    return this.sessions.get(projectId) ?? null;
  }

  async tooling(): Promise<DeviceTooling> {
    const { which, platform } = this.deps;
    const [xcrun, adb, idb] = await Promise.all([
      platform === 'darwin' ? which('xcrun') : Promise.resolve(null),
      which('adb'),
      platform === 'darwin' ? which('idb') : Promise.resolve(null),
    ]);
    // `xcrun` exists on every Mac with the command line tools; the simulator needs Xcode proper. `adb` is only
    // counted when it runs (a broken SDK install on PATH is no SDK).
    const [ios, android] = await Promise.all([
      xcrun !== null ? this.simctlWorks() : Promise.resolve(false),
      adb !== null ? this.adbWorks() : Promise.resolve(false),
    ]);
    return {
      ios,
      android,
      iosInput: ios && idb !== null,
      androidInput: android,
      screenAccess: this.deps.screenAccess(),
    };
  }

  async list(platform?: DevicePlatform): Promise<DeviceSummary[]> {
    const tooling = await this.tooling();
    const out: DeviceSummary[] = [];
    if (platform === undefined || platform === 'ios') out.push(...(await this.listFor('ios', tooling)));
    if (platform === undefined || platform === 'android')
      out.push(...(await this.listFor('android', tooling)));
    return sortDevices(out);
  }

  /**
   * Boots the device for a project — the one asked for, else the project's remembered one, else the best available
   * — and publishes the session as it goes: `booting` at once (the pane shows "Booting …"), `ready` with the screen
   * size, or `failed` with the reason (which is also thrown). A project already on that device just re-publishes;
   * another device replaces the session.
   */
  async boot(
    projectId: ProjectId,
    platform: DevicePlatform,
    device: string | null,
  ): Promise<{ deviceId: string; deviceName: string }> {
    const tooling = await this.tooling();
    if (platform === 'ios' ? !tooling.ios : !tooling.android)
      fail(
        'cli-missing',
        platform === 'ios' ? copy.workspace.device.noToolingIos : copy.workspace.device.noToolingAndroid,
      );
    const list = await this.listFor(platform, tooling);
    const remembered = this.deps.repos.projects.settings(projectId).devDevice ?? null;
    const picked =
      pickDevice(list, device, remembered) ??
      fail(
        'not-found',
        fill(copy.workspace.device.noDevices, { platform: copy.workspace.device.platforms[platform] }),
      );
    if (!DEVICE_ID.test(picked.id)) fail('internal', `unexpected device id for ${picked.name}`);
    this.runtimes.set(projectId, picked.runtime);

    const current = this.sessions.get(projectId);
    if (
      current !== undefined &&
      current.phase === 'ready' &&
      current.platform === platform &&
      (current.deviceId === picked.id || current.deviceName === picked.name)
    ) {
      this.publish(current);
      return { deviceId: current.deviceId, deviceName: current.deviceName };
    }
    // Another device (or a session that never got ready): whatever was going on for this project stops first.
    this.release(projectId);
    const token: BootToken = { cancelled: false };
    this.boots.set(projectId, token);
    const session: DeviceSession = {
      projectId,
      platform,
      deviceId: picked.id,
      deviceName: picked.name,
      phase: 'booting',
      mirror: 'none',
      input: false,
      error: null,
      screen: null,
      startedAt: this.deps.clock.now(),
    };
    this.publish(session);
    logger.info('device: booting', { platform, device: picked.name });
    try {
      const ready =
        platform === 'ios' ? await this.bootIos(picked, token) : await this.bootAndroid(picked, token);
      if (token.cancelled) fail('internal', copy.workspace.device.stopped);
      this.publish({ ...session, phase: 'ready', deviceId: ready.deviceId, screen: ready.screen });
      logger.info('device: ready', { platform, device: picked.name, screen: ready.screen });
      return { deviceId: ready.deviceId, deviceName: picked.name };
    } catch (e) {
      const message = redact(e instanceof Error ? e.message : String(e));
      // A cancelled boot has no row left to fail: `stop()` published null, or a new boot owns the row.
      if (!token.cancelled) {
        this.publish({ ...session, phase: 'failed', error: message });
        logger.warn('device: boot failed', { platform, device: picked.name, error: message });
      }
      if (e instanceof CommandError) throw e;
      return fail('internal', message);
    } finally {
      if (this.boots.get(projectId) === token) this.boots.delete(projectId);
    }
  }

  /**
   * How the design window should show the device. The simulator's own window is captured live when the OS lets
   * Styx (Screen Recording on macOS) and the window can be found; otherwise screenshots are polled for as long as
   * the pane keeps calling this (the heartbeat). Also decides whether input can be forwarded.
   */
  async mirror(projectId: ProjectId): Promise<{ mode: DeviceSession['mirror']; reason: string | null }> {
    const session = this.sessions.get(projectId);
    if (session === undefined) return { mode: 'none', reason: copy.workspace.device.empty };
    if (session.phase === 'booting')
      return { mode: 'none', reason: fill(copy.workspace.device.booting, { device: session.deviceName }) };
    if (session.phase !== 'ready')
      return {
        mode: 'none',
        reason: session.error ?? fill(copy.workspace.device.failed, { error: session.phase }),
      };
    const input =
      session.platform === 'android'
        ? (await this.deps.which('adb')) !== null
        : (await this.deps.which('idb')) !== null;
    const access = this.deps.screenAccess();
    if (access === 'granted' || access === 'n/a') {
      const source = matchWindowSource(await this.deps.windowSources(), {
        platform: session.platform,
        id: session.deviceId,
        name: session.deviceName,
        runtime: this.runtimes.get(projectId) ?? null,
      });
      if (source !== null) {
        this.armed = source;
        this.armedFor = projectId;
        this.armedAt = this.deps.clock.now();
        // A live capture replaces the screenshot poller.
        this.stopPolling(projectId);
        this.update(session, { mirror: 'window', input });
        return { mode: 'window', reason: null };
      }
    }
    this.watch(projectId);
    this.update(session, { mirror: 'screenshots', input });
    return {
      mode: 'screenshots',
      reason: access === 'denied' || access === 'not-determined' ? copy.workspace.device.screenAccess : null,
    };
  }

  /**
   * Forwards a tap / swipe / key / text to the device. Coordinates are the screenshot's pixels and must be on the
   * screen; text is whitelisted because `adb shell` re-parses its line on the device and idb's `ui text` is typed
   * key by key. Refused outright when no input bridge exists.
   */
  async input(projectId: ProjectId, event: DeviceInput): Promise<void> {
    const session = this.ready(projectId);
    if (!session.input)
      fail(
        'cli-missing',
        session.platform === 'ios' ? copy.workspace.device.noInputIos : copy.workspace.device.noInput,
      );
    const id = this.argvId(session.deviceId);
    const screen = session.screen;
    const onScreen = (x: number, y: number) => {
      if (screen !== null && (x >= screen.width || y >= screen.height))
        fail(
          'invalid-input',
          fill(copy.workspace.device.outsideScreen, {
            x,
            y,
            width: screen.width,
            height: screen.height,
          }),
        );
    };
    const text = (t: string) => {
      if (!TEXT_OK.test(t)) fail('invalid-input', copy.workspace.device.textNotAllowed);
      return t;
    };
    if (session.platform === 'android') {
      const adb = (...args: string[]) => this.run('adb', ['-s', id, 'shell', 'input', ...args]);
      switch (event.kind) {
        case 'tap':
          onScreen(event.x, event.y);
          return adb('tap', String(event.x), String(event.y));
        case 'swipe':
          onScreen(event.x1, event.y1);
          onScreen(event.x2, event.y2);
          return adb(
            'swipe',
            String(event.x1),
            String(event.y1),
            String(event.x2),
            String(event.y2),
            String(event.durationMs),
          );
        case 'key':
          return adb('keyevent', ANDROID_KEYS[event.key]);
        case 'text':
          return adb('text', androidText(text(event.text)));
      }
    }
    // idb's HID coordinates are points (FBSimulatorHID scales to the framebuffer itself) while the screenshot is in
    // pixels, so pane coordinates are divided by the density `idb describe --json` reports in `screen_dimensions`.
    const scale = await this.iosScale(projectId, id);
    const pt = (v: number) => String(Math.round(v / scale));
    const idb = (...args: string[]) => this.run('idb', ['ui', ...args, '--udid', id]);
    switch (event.kind) {
      case 'tap':
        onScreen(event.x, event.y);
        return idb('tap', pt(event.x), pt(event.y));
      case 'swipe':
        onScreen(event.x1, event.y1);
        onScreen(event.x2, event.y2);
        return idb(
          'swipe',
          pt(event.x1),
          pt(event.y1),
          pt(event.x2),
          pt(event.y2),
          '--duration',
          String(event.durationMs / 1000),
        );
      case 'key':
        if (event.key === 'home') return idb('button', 'HOME');
        // iOS has no back key; escape is the nearest thing a keyboard offers.
        return idb('key', IDB_KEYS[event.key === 'back' ? 'escape' : event.key]);
      case 'text':
        return idb('text', text(event.text));
    }
  }

  /** Brings the simulator's own window forward (no input bridge needed). The emulator has no such switch. */
  async focus(projectId: ProjectId): Promise<void> {
    const session = this.ready(projectId);
    if (session.platform === 'android') fail('cli-missing', copy.workspace.device.noInput);
    await this.run('open', ['-a', 'Simulator']);
  }

  /** Stops mirroring, forgets the session and, when asked, shuts the simulator / emulator down. */
  async stop(projectId: ProjectId, shutdown: boolean): Promise<void> {
    this.release(projectId);
    const session = this.sessions.get(projectId);
    if (session === undefined) return;
    this.sessions.delete(projectId);
    this.densities.delete(projectId);
    this.deps.screens.dropFrame(projectId);
    this.deps.publisher.devicesSet(projectId, null);
    logger.info('device: stopped', { device: session.deviceName, shutdown });
    // An AVD name is not a serial: an emulator that never came up has nothing to kill.
    const known = session.platform === 'ios' || /^emulator-\d+$/.test(session.deviceId);
    if (!shutdown || session.phase === 'failed' || !known || !DEVICE_ID.test(session.deviceId)) return;
    const r =
      session.platform === 'ios'
        ? await this.deps.exec('xcrun', ['simctl', 'shutdown', session.deviceId], { timeoutMs: 60_000 })
        : await this.deps.exec('adb', ['-s', session.deviceId, 'emu', 'kill'], { timeoutMs: 15_000 });
    if (r.exitCode !== 0)
      logger.warn('device: shutdown failed', { device: session.deviceName, error: errorText(r, 'shutdown') });
  }

  /** A PNG of the device's screen right now, or null when nothing is mirrored (checkpoint screenshots). */
  async screenshot(projectId: ProjectId): Promise<Buffer | null> {
    const session = this.sessions.get(projectId);
    if (session === undefined || session.phase !== 'ready') return null;
    return this.grab(session).catch(() => null);
  }

  /** Answers the renderer's `getDisplayMedia` with the armed window, once; null = deny. */
  takeArmedSource(): WindowSource | null {
    // An arm nobody collected in time is void: the renderer asks right after `device.mirror`, so a late request
    // is not the one that was armed for.
    const s = this.deps.clock.now() - this.armedAt <= ARM_TTL_MS ? this.armed : null;
    this.armed = null;
    this.armedFor = null;
    return s;
  }

  async openScreenAccess(): Promise<void> {
    await this.deps.openScreenAccess();
  }

  /** Stops every poller and boot (app shutdown); simulators are the user's and stay up. */
  shutdown(): void {
    for (const id of new Set([...this.pollers.keys(), ...this.watchers.keys(), ...this.boots.keys()]))
      this.release(id);
  }

  // --- booting -------------------------------------------------------------

  /**
   * `simctl boot` (already booted is fine: exit 149), `bootstatus -b` blocks until the runtime is up, then
   * Simulator.app is asked to show the device (not fatal: a headless simulator still screenshots) and one screenshot
   * tells the screen size.
   */
  private async bootIos(
    device: DeviceSummary,
    token: BootToken,
  ): Promise<{ deviceId: string; screen: DeviceSession['screen'] }> {
    const udid = device.id;
    const boot = await this.deps.exec('xcrun', ['simctl', 'boot', udid], { timeoutMs: 60_000 });
    const alreadyBooted = boot.exitCode === 149 || /current state: Booted/i.test(boot.stderr);
    if (boot.exitCode !== 0 && !alreadyBooted) fail('internal', errorText(boot, 'simctl boot'));
    if (token.cancelled) fail('internal', copy.workspace.device.stopped);
    const status = await this.deps.exec('xcrun', ['simctl', 'bootstatus', udid, '-b'], {
      timeoutMs: BOOT_TIMEOUT_MS,
    });
    if (status.exitCode !== 0) fail('internal', errorText(status, 'simctl bootstatus'));
    if (token.cancelled) fail('internal', copy.workspace.device.stopped);
    const opened = await this.deps
      .exec('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid], { timeoutMs: 15_000 })
      .catch((e: Error) => ({ stdout: '', stderr: e.message, exitCode: 1 }));
    if (opened.exitCode !== 0)
      logger.warn('device: Simulator.app did not open', {
        device: device.name,
        error: errorText(opened, 'open'),
      });
    const png = await this.iosScreenshot(udid);
    return { deviceId: udid, screen: png === null ? null : pngSize(png) };
  }

  /**
   * An AVD name starts the emulator (detached; Styx never waits for it) and the new serial is found by polling
   * `adb devices`; a serial means it is already running. Either way `sys.boot_completed` says when Android is up,
   * and `wm size` gives the screen. The session's id becomes the serial (what every adb call needs).
   */
  private async bootAndroid(
    device: DeviceSummary,
    token: BootToken,
  ): Promise<{ deviceId: string; screen: DeviceSession['screen'] }> {
    const { exec, which } = this.deps;
    const attempts = Math.ceil(BOOT_TIMEOUT_MS / ANDROID_POLL_MS);
    let serial: string | null = /^emulator-\d+$/.test(device.id) ? device.id : null;
    if (serial === null) {
      const before = new Set(
        parseAdbSerials((await exec('adb', ['devices', '-l'])).stdout).map((d) => d.serial),
      );
      const bin = (await which('emulator')) ?? fail('cli-missing', copy.workspace.device.noToolingAndroid);
      (this.deps.spawn ?? defaultSpawn)(bin, ['-avd', device.id, '-no-boot-anim']);
      for (let i = 0; i < attempts && serial === null; i++) {
        await sleep(ANDROID_POLL_MS);
        if (token.cancelled) fail('internal', copy.workspace.device.stopped);
        const fresh = parseAdbSerials((await exec('adb', ['devices', '-l'])).stdout)
          .map((d) => d.serial)
          .filter((s) => !before.has(s) && DEVICE_ID.test(s));
        // Two emulators starting at once: `emu avd name` tells which is ours; failing that, the first new one.
        for (const s of fresh) {
          const name = await exec('adb', ['-s', s, 'emu', 'avd', 'name'], { timeoutMs: 10_000 });
          if (name.exitCode === 0 && name.stdout.split('\n')[0]?.trim() === device.id) serial = s;
        }
        serial ??= fresh[0] ?? null;
      }
      if (serial === null) fail('internal', `${device.name} did not appear in adb devices`);
    }
    let booted = false;
    for (let i = 0; i < attempts && !booted; i++) {
      if (token.cancelled) fail('internal', copy.workspace.device.stopped);
      const r = await exec('adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
        timeoutMs: 10_000,
      });
      booted = r.exitCode === 0 && r.stdout.trim() === '1';
      if (!booted) await sleep(ANDROID_POLL_MS);
    }
    if (!booted) fail('internal', `${device.name} did not finish booting`);
    const wm = await exec('adb', ['-s', serial, 'shell', 'wm', 'size'], { timeoutMs: 10_000 });
    return { deviceId: serial, screen: wm.exitCode === 0 ? parseWmSize(wm.stdout) : null };
  }

  // --- screenshots ---------------------------------------------------------

  /** (Re)starts the poller and pushes the stop-after-heartbeat timer out. */
  private watch(projectId: string): void {
    const old = this.watchers.get(projectId);
    if (old !== undefined) clearTimeout(old);
    const t = setTimeout(() => {
      this.watchers.delete(projectId);
      this.stopPolling(projectId);
    }, WATCH_MS);
    t.unref?.();
    this.watchers.set(projectId, t);
    if (!this.pollers.has(projectId) && !this.inFlight.has(projectId)) void this.tick(projectId);
  }

  /** One screenshot, then the next tick `frameMs` after it finished — never overlapping, never faster than that. */
  private async tick(projectId: string): Promise<void> {
    this.pollers.delete(projectId);
    const session = this.sessions.get(projectId);
    if (session === undefined || session.phase !== 'ready' || !this.watchers.has(projectId)) return;
    if (this.inFlight.has(projectId)) return;
    this.inFlight.add(projectId);
    try {
      const png = await this.grab(session);
      // The session may have been stopped while the shot was taken: a frame for it would outlive the row.
      if (png !== null && this.sessions.get(projectId)?.phase === 'ready') {
        const seq = this.deps.screens.putFrame(projectId, png);
        this.deps.onFrame(projectId as ProjectId, seq);
      }
    } catch (e) {
      logger.debug('device: screenshot failed', { device: session.deviceName, error: (e as Error).message });
    } finally {
      this.inFlight.delete(projectId);
    }
    if (!this.watchers.has(projectId) || this.sessions.get(projectId)?.phase !== 'ready') return;
    const t = setTimeout(() => void this.tick(projectId), this.deps.frameMs ?? DEFAULT_FRAME_MS);
    t.unref?.();
    this.pollers.set(projectId, t);
  }

  private async grab(session: DeviceSession): Promise<Buffer | null> {
    const id = this.argvId(session.deviceId);
    if (session.platform === 'ios') return this.iosScreenshot(id);
    const r = await this.deps.exec('adb', ['-s', id, 'exec-out', 'screencap', '-p'], {
      timeoutMs: 15_000,
      binary: true,
    });
    return r.exitCode === 0 && r.bytes !== undefined && r.bytes.length > 0 ? r.bytes : null;
  }

  /** `simctl io … screenshot` only writes to a file: a temp file, read and removed at once. */
  private async iosScreenshot(udid: string): Promise<Buffer | null> {
    const file = join(tmpdir(), `styx-shot-${ulid()}.png`);
    try {
      const r = await this.deps.exec('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', file], {
        timeoutMs: 15_000,
      });
      if (r.exitCode !== 0) return null;
      return await readFile(file);
    } catch {
      return null;
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }

  // --- helpers -------------------------------------------------------------

  private async listFor(platform: DevicePlatform, tooling: DeviceTooling): Promise<DeviceSummary[]> {
    if (platform === 'ios') {
      if (!tooling.ios) return [];
      const r = await this.deps.exec('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
        timeoutMs: 15_000,
      });
      return r.exitCode === 0 ? parseSimctlList(r.stdout) : [];
    }
    if (!tooling.android) return [];
    const [avds, devices] = await Promise.all([
      this.deps
        .which('emulator')
        .then((p) =>
          p === null ? { stdout: '', stderr: '', exitCode: 1 } : this.deps.exec('emulator', ['-list-avds']),
        ),
      this.deps.exec('adb', ['devices', '-l'], { timeoutMs: 15_000 }),
    ]);
    return parseAndroidDevices(avds.exitCode === 0 ? avds.stdout : '', devices.stdout);
  }

  /** The session, ready; anything else is refused with what the pane would say. */
  private ready(projectId: ProjectId): DeviceSession {
    const session = this.sessions.get(projectId);
    if (session === undefined) fail('not-found', copy.workspace.device.empty);
    if (session.phase === 'booting')
      fail('invalid-transition', fill(copy.workspace.device.booting, { device: session.deviceName }));
    if (session.phase !== 'ready')
      fail(
        'invalid-transition',
        session.error ?? fill(copy.workspace.device.failed, { error: session.phase }),
      );
    return session;
  }

  private argvId(id: string): string {
    if (!DEVICE_ID.test(id)) fail('internal', 'unexpected device id');
    return id;
  }

  /** Runs a tool that must succeed; its stderr is the error. */
  private async run(bin: string, args: string[]): Promise<void> {
    const r = await this.deps.exec(bin, args, { timeoutMs: 15_000 });
    if (r.exitCode !== 0) fail('internal', errorText(r, `${bin} ${args[0] ?? ''}`.trim()));
  }

  /** The scale between idb's points and the screenshot's pixels; 1 when idb cannot say. */
  private async iosScale(projectId: string, udid: string): Promise<number> {
    const cached = this.densities.get(projectId);
    if (cached !== undefined) return cached;
    let density = 1;
    const r = await this.deps.exec('idb', ['describe', '--udid', udid, '--json'], { timeoutMs: 15_000 });
    if (r.exitCode === 0) {
      try {
        const d = (JSON.parse(r.stdout) as { screen_dimensions?: { density?: unknown } }).screen_dimensions
          ?.density;
        if (typeof d === 'number' && d > 0) density = d;
      } catch {
        /* not json: points and pixels are taken as the same */
      }
    }
    this.densities.set(projectId, density);
    return density;
  }

  private async simctlWorks(): Promise<boolean> {
    const r = await this.deps.exec('xcrun', ['simctl', 'help'], { timeoutMs: 8000 }).catch(() => null);
    return r !== null && r.exitCode === 0;
  }

  private async adbWorks(): Promise<boolean> {
    const r = await this.deps.exec('adb', ['version'], { timeoutMs: 8000 }).catch(() => null);
    return r !== null && r.exitCode === 0;
  }

  /** Everything in flight for a project stops: the boot, the poller, the heartbeat, the armed window. */
  private release(projectId: string): void {
    const boot = this.boots.get(projectId);
    if (boot !== undefined) {
      boot.cancelled = true;
      this.boots.delete(projectId);
    }
    const w = this.watchers.get(projectId);
    if (w !== undefined) clearTimeout(w);
    this.watchers.delete(projectId);
    this.stopPolling(projectId);
    if (this.armedFor === projectId) {
      this.armed = null;
      this.armedFor = null;
    }
  }

  private stopPolling(projectId: string): void {
    const t = this.pollers.get(projectId);
    if (t !== undefined) clearTimeout(t);
    this.pollers.delete(projectId);
  }

  /** Publishes only when something changed: the heartbeat must not turn into a delta every few seconds. */
  private update(session: DeviceSession, patch: Pick<DeviceSession, 'mirror' | 'input'>): void {
    const cur = this.sessions.get(session.projectId);
    if (cur !== undefined && cur.mirror === patch.mirror && cur.input === patch.input) return;
    this.publish({ ...session, ...patch, error: null });
  }

  protected publish(session: DeviceSession): void {
    this.sessions.set(session.projectId, session);
    this.deps.publisher.devicesSet(session.projectId, session);
  }
}
