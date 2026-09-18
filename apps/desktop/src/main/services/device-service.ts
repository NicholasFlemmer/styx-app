import type { DeviceInput, DevicePlatform, DeviceSession, DeviceSummary, ProjectId } from '@styx/core';
import { execa } from 'execa';
import type { Clock } from '../clock';
import type { Repos } from '../db/repos';
import { fail } from '../ipc/bus';
import type { Publisher } from '../store/publisher';
import type { ScreensStore } from './screens-store';

/** Runs a tool and returns what it printed; never throws for a non-zero exit (`exitCode` says). */
export type DeviceExec = (
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

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
}

export interface DeviceTooling {
  ios: boolean;
  android: boolean;
  iosInput: boolean;
  androidInput: boolean;
  screenAccess: ScreenAccess;
}

/** The default runner: the tool on the login shell's PATH (Xcode's `xcrun`, the SDK's `adb`), no shell in between. */
export const execaDeviceExec =
  (loginPath: () => Promise<string>): DeviceExec =>
  async (bin, args, opts = {}) => {
    const PATH = await loginPath();
    const r = await execa(bin, args, {
      reject: false,
      timeout: opts.timeoutMs ?? 30_000,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: { ...process.env, PATH, NO_COLOR: '1' },
      encoding: 'utf8',
    });
    return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: r.exitCode ?? 1 };
  };

/** `which`/`where` on the login shell's PATH: the first hit, or null. */
export const execaWhich =
  (loginPath: () => Promise<string>, platform: NodeJS.Platform) =>
  async (bin: string): Promise<string | null> => {
    if (!/^[A-Za-z0-9._-]+$/.test(bin)) return null;
    const PATH = await loginPath();
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

/** `emulator -list-avds` (one name per line) plus `adb devices -l` (running emulators) → summaries. */
export const parseAndroidDevices = (avds: string, adbDevices: string): DeviceSummary[] => {
  const running = new Map<string, string>(); // avd name → serial
  for (const line of adbDevices.split('\n')) {
    const m = /^(emulator-\d+)\s+(device|offline)\b/.exec(line.trim());
    if (!m) continue;
    // `adb devices -l` does not name the AVD; the `emu avd name` lookup is the service's job. The serial is kept
    // under its own key so a running emulator still lists when no AVD name could be matched.
    running.set(m[1] ?? '', m[2] ?? '');
  }
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
  for (const [serial, state] of running)
    out.push({
      platform: 'android',
      id: serial,
      name: serial,
      runtime: null,
      state: state === 'device' ? 'booted' : 'booting',
    });
  return sortDevices(out);
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
  device: Pick<DeviceSummary, 'platform' | 'name' | 'id'>,
): WindowSource | null => {
  const name = device.name.toLowerCase();
  const avd = device.id.toLowerCase();
  for (const s of sources) {
    const title = s.name.toLowerCase();
    // The separator must follow the name at once: `iPhone 17` is not `iPhone 17 Pro – iOS 26.5`.
    if (device.platform === 'ios' && title.startsWith(name) && /^\s*[–—-]/.test(title.slice(name.length)))
      return s;
    if (
      device.platform === 'android' &&
      title.startsWith('android emulator') &&
      (title.includes(avd) || title.includes(name))
    )
      return s;
  }
  return null;
};

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
  private readonly pollers = new Map<string, NodeJS.Timeout>();
  /** The window source a `getDisplayMedia` request from the renderer should get, armed by `mirror()`. */
  private armed: WindowSource | null = null;

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
    // `xcrun` exists on every Mac with the command line tools; the simulator needs Xcode proper.
    const ios = xcrun !== null && (await this.simctlWorks());
    return {
      ios,
      android: adb !== null,
      iosInput: ios && idb !== null,
      androidInput: adb !== null,
      screenAccess: this.deps.screenAccess(),
    };
  }

  async list(platform?: DevicePlatform): Promise<DeviceSummary[]> {
    const out: DeviceSummary[] = [];
    const tooling = await this.tooling();
    if ((platform === undefined || platform === 'ios') && tooling.ios) {
      const r = await this.deps.exec('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
        timeoutMs: 15_000,
      });
      if (r.exitCode === 0) out.push(...parseSimctlList(r.stdout));
    }
    if ((platform === undefined || platform === 'android') && tooling.android) {
      const [avds, devices] = await Promise.all([
        this.deps
          .which('emulator')
          .then((p) =>
            p === null ? { stdout: '', stderr: '', exitCode: 1 } : this.deps.exec('emulator', ['-list-avds']),
          ),
        this.deps.exec('adb', ['devices', '-l'], { timeoutMs: 15_000 }),
      ]);
      out.push(...parseAndroidDevices(avds.exitCode === 0 ? avds.stdout : '', devices.stdout));
    }
    return sortDevices(out);
  }

  // The remaining operations are filled in by the device work package; until then they say so honestly.

  async boot(
    _projectId: ProjectId,
    _platform: DevicePlatform,
    _device: string | null,
  ): Promise<{ deviceId: string; deviceName: string }> {
    return fail('internal', 'device boot is not available yet');
  }

  async mirror(_projectId: ProjectId): Promise<{ mode: DeviceSession['mirror']; reason: string | null }> {
    return { mode: 'none', reason: 'device mirroring is not available yet' };
  }

  async input(_projectId: ProjectId, _event: DeviceInput): Promise<void> {
    fail('internal', 'device input is not available yet');
  }

  async focus(_projectId: ProjectId): Promise<void> {
    fail('internal', 'no device is mirrored');
  }

  async stop(projectId: ProjectId, _shutdown: boolean): Promise<void> {
    this.stopPolling(projectId);
    if (!this.sessions.has(projectId)) return;
    this.sessions.delete(projectId);
    this.deps.screens.dropFrame(projectId);
    this.deps.publisher.devicesSet(projectId, null);
  }

  /** A PNG of the device's screen right now, or null when nothing is mirrored (checkpoint screenshots). */
  async screenshot(_projectId: ProjectId): Promise<Buffer | null> {
    return null;
  }

  /** Answers the renderer's `getDisplayMedia` with the armed window, once; null = deny. */
  takeArmedSource(): WindowSource | null {
    const s = this.armed;
    this.armed = null;
    return s;
  }

  async openScreenAccess(): Promise<void> {
    await this.deps.openScreenAccess();
  }

  /** Stops every poller (app shutdown); simulators are the user's and stay up. */
  shutdown(): void {
    for (const id of [...this.pollers.keys()]) this.stopPolling(id);
  }

  private async simctlWorks(): Promise<boolean> {
    const r = await this.deps.exec('xcrun', ['simctl', 'help'], { timeoutMs: 8000 }).catch(() => null);
    return r !== null && r.exitCode === 0;
  }

  private stopPolling(projectId: string): void {
    const t = this.pollers.get(projectId);
    if (t !== undefined) clearInterval(t);
    this.pollers.delete(projectId);
  }

  protected publish(session: DeviceSession): void {
    this.sessions.set(session.projectId, session);
    this.deps.publisher.devicesSet(session.projectId, session);
  }
}
