import { copy, UPDATE_OFF, type UpdateState } from '@styx/core';
import type { Clock } from '../clock';
import { fail } from '../ipc/bus';
import { logger } from './logger';

/** The part of electron-updater's `autoUpdater` Styx uses (injected, so tests drive it without a network). */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'checking-for-update' | 'update-not-available', listener: () => void): unknown;
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'download-progress', listener: (p: { percent: number }) => void): unknown;
  on(event: 'error', listener: (e: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateServiceDeps {
  /** Null in development, under the e2e harness, and in a build without an update feed: the state stays `off`. */
  updater: Updater | null;
  version: string;
  clock: Clock;
  publish: (state: UpdateState) => void;
  /** First look after launch (default 15 s), then every `intervalMs` (default 30 min), and on focus after `focusGapMs` (10 min). */
  firstCheckMs?: number;
  intervalMs?: number;
  focusGapMs?: number;
}

/**
 * Updates in place (owner request, #119). A packaged, signed Styx asks its update feed shortly after launch and
 * every few hours; a newer build downloads in the background (only the changed blocks when it can) and installs
 * itself the next time Styx quits — or at once on "Restart to update". Nothing here can stop the app working: a
 * failed check is a line in Settings, never a dialog. The update must carry the same Developer ID signature as the
 * running app (Squirrel.Mac / NSIS verify it), so a feed can only ever deliver Styx.
 */
export class UpdateService {
  private state: UpdateState;
  private timers: NodeJS.Timeout[] = [];
  private lastPercent = -1;
  private lastCheck = 0;

  constructor(private readonly deps: UpdateServiceDeps) {
    this.state =
      deps.updater === null
        ? { ...UPDATE_OFF, current: deps.version }
        : { ...UPDATE_OFF, current: deps.version, status: 'idle' };
    const u = deps.updater;
    if (u === null) return;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.on('checking-for-update', () => {
      if (this.state.status === 'ready' || this.state.status === 'downloading') return;
      this.set({ status: 'checking', error: null });
    });
    u.on('update-not-available', () =>
      this.set({ status: 'idle', next: null, percent: null, checkedAt: this.deps.clock.now(), error: null }),
    );
    u.on('update-available', (info) => {
      this.lastPercent = 0;
      this.set({
        status: 'downloading',
        next: info.version,
        percent: 0,
        checkedAt: this.deps.clock.now(),
        error: null,
      });
    });
    u.on('download-progress', (p) => {
      const percent = Math.max(0, Math.min(100, Math.floor(p.percent)));
      if (percent === this.lastPercent) return;
      this.lastPercent = percent;
      this.set({ status: 'downloading', percent });
    });
    u.on('update-downloaded', (info) => {
      logger.info('update: downloaded', { version: info.version });
      this.set({ status: 'ready', next: info.version, percent: 100, error: null });
    });
    u.on('error', (e) => {
      logger.warn('update: failed', { error: e.message.split('\n')[0] });
      // A download that finished stays installable whatever a later check says.
      if (this.state.status === 'ready') return;
      this.set({ status: 'error', percent: null, error: plainReason(e) });
    });
  }

  current(): UpdateState {
    return this.state;
  }

  /** First check shortly after launch, then on an interval. */
  start(): void {
    if (this.deps.updater === null) return;
    const first = setTimeout(() => void this.check(), this.deps.firstCheckMs ?? 15_000);
    const every = setInterval(() => void this.check(), this.deps.intervalMs ?? 30 * 60_000);
    first.unref?.();
    every.unref?.();
    this.timers.push(first, every);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /**
   * The window came to the front: ask again if the last check is older than `focusGapMs`, so a release published
   * while Styx was open is found the next time the person looks at it, and its dialog opens by itself.
   */
  async onFocus(): Promise<void> {
    if (this.deps.clock.now() - this.lastCheck < (this.deps.focusGapMs ?? 10 * 60_000)) return;
    await this.check();
  }

  /** Asks the feed now. Never throws: the outcome arrives through the updater's events. */
  async check(): Promise<void> {
    const u = this.deps.updater;
    if (u === null || this.state.status === 'downloading' || this.state.status === 'ready') return;
    this.lastCheck = this.deps.clock.now();
    try {
      await u.checkForUpdates();
    } catch (e) {
      // electron-updater also emits `error`; this catch only keeps the promise quiet.
      logger.debug('update: check threw', { error: (e as Error).message.split('\n')[0] });
    }
  }

  /** Quits, installs the downloaded build and reopens Styx (the normal quit path runs first: sessions stop cleanly). */
  install(): void {
    const u = this.deps.updater;
    if (u === null || this.state.status !== 'ready') fail('invalid-transition', copy.update.notReady);
    logger.info('update: installing', { version: this.state.next });
    u.quitAndInstall(false, true);
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.publish(this.state);
  }
}

/** A failure the Settings row can show: offline, or the feed did not answer; never a stack or a URL with a query. */
export const plainReason = (e: Error): string =>
  /ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::ERR_INTERNET_DISCONNECTED|net::ERR_NAME_NOT_RESOLVED/i.test(
    e.message,
  )
    ? copy.update.offline
    : copy.update.failed;
