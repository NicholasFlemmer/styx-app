/** Injected time source (ADR-0011): services never call `Date.now()` directly. `STYX_NOW` freezes it for fixtures/e2e. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const fixedClock = (at: number): Clock => ({ now: () => at });

/** A clock tests can advance. */
export class ManualClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export function clockFromEnv(env: NodeJS.ProcessEnv = process.env): Clock {
  const raw = env['STYX_NOW'];
  if (raw !== undefined && raw !== '') {
    const at = Number(raw);
    if (Number.isFinite(at)) return fixedClock(at);
  }
  return systemClock;
}
