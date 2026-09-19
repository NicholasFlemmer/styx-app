import { watch, type FSWatcher } from 'node:fs';
import { logger } from './logger';

export interface CliWatchDeps {
  /** Runs once per burst of changes (a re-detect); errors are logged, never thrown into the fs callback. */
  onChange: () => Promise<unknown> | unknown;
  debounceMs?: number;
}

/**
 * Notices an agent CLI being installed (or removed) while Styx runs: one non-recursive `fs.watch` per folder the
 * last detection scanned — the login PATH's folders and the vendors' install folders (`DetectService.onSearched`)
 * — and a debounced re-detect when any of them changes. So `curl … | bash` in a terminal shows up in Settings ›
 * Agents within a second, without a focus change or a restart (owner addition, docs/handoff-discrepancies #98).
 * A folder that appears later (`~/.local/bin` created by an installer) is picked up by the next detection's list.
 */
export class CliWatchService {
  private readonly watchers = new Map<string, FSWatcher>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(private readonly deps: CliWatchDeps) {}

  start(): void {
    this.started = true;
  }

  /** Watches exactly these folders from now on; ones that vanished or were dropped from the list are released. */
  update(dirs: readonly string[]): void {
    if (!this.started) return;
    const want = new Set(dirs);
    for (const [dir, w] of this.watchers) {
      if (want.has(dir)) continue;
      w.close();
      this.watchers.delete(dir);
    }
    for (const dir of want) {
      if (this.watchers.has(dir)) continue;
      try {
        const w = watch(dir, { persistent: false }, () => this.bump());
        w.on('error', () => {
          w.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, w);
      } catch {
        // Gone between the scan and now; the next detection's list will not carry it.
      }
    }
  }

  /** Number of folders under watch (tests, diagnostics). */
  get size(): number {
    return this.watchers.size;
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  private bump(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void Promise.resolve()
        .then(() => this.deps.onChange())
        .catch((e: unknown) => logger.warn('cli watch: re-detect failed', { error: (e as Error).message }));
    }, this.deps.debounceMs ?? 500);
    this.timer.unref?.();
  }
}
