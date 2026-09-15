/**
 * Waits for a URL to answer before the design window loads it. A dev server prints its address before it accepts
 * connections, and Chromium's "connection refused" page would otherwise sit there until someone pressed Reload.
 * Pure (timers and the probe are injected) so it can be tested without Electron.
 */
export type PreviewPhase = 'waiting' | 'loaded' | 'failed';
export interface PreviewStatus {
  url: string;
  phase: PreviewPhase;
  attempts: number;
}

export interface PreviewProbeDeps {
  probe: (url: string) => Promise<boolean>;
  onReady: (url: string) => void;
  onStatus: (status: PreviewStatus) => void;
  intervalMs?: number;
  maxAttempts?: number;
  setTimeout?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout?: (t: NodeJS.Timeout) => void;
}

export class PreviewProbe {
  private wanted: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(private readonly deps: PreviewProbeDeps) {}

  /** Starts (or restarts) probing `url`; an earlier URL's pending attempt is abandoned. */
  start(url: string): void {
    this.stop();
    this.wanted = url;
    const gen = ++this.generation;
    const interval = this.deps.intervalMs ?? 1000;
    const max = this.deps.maxAttempts ?? 120;
    const set = this.deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    let attempts = 0;
    const tick = async () => {
      if (gen !== this.generation) return;
      attempts += 1;
      const ok = await this.deps.probe(url);
      if (gen !== this.generation) return;
      if (ok) {
        this.timer = null;
        this.deps.onStatus({ url, phase: 'loaded', attempts });
        this.deps.onReady(url);
        return;
      }
      if (attempts >= max) {
        this.timer = null;
        this.deps.onStatus({ url, phase: 'failed', attempts });
        return;
      }
      this.deps.onStatus({ url, phase: 'waiting', attempts });
      this.timer = set(() => void tick(), interval);
      this.timer.unref?.();
    };
    void tick();
  }

  /** Probes the current URL again (Retry, or the server went away after loading). */
  restart(): void {
    if (this.wanted !== null) this.start(this.wanted);
  }

  stop(): void {
    this.generation += 1;
    if (this.timer !== null) (this.deps.clearTimeout ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  current(): string | null {
    return this.wanted;
  }

  reset(): void {
    this.stop();
    this.wanted = null;
  }
}
