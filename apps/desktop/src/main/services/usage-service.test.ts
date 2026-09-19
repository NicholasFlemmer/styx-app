import { EventEmitter } from 'node:events';
import { fixtures, type AgentLimits, type CliInstall } from '@styx/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTestApp, type TestApp } from '../test-support';
import type { StreamEffect, StreamEvents, StreamRunnerLike, StreamSpawnOptions } from './stream-runner';
import { limitsKey, UsageService } from './usage-service';

const { DEMO_NOW, ids } = fixtures;
const MIN = 60_000;
const HOUR = 60 * MIN;

const codexLimits = (updatedAt: number): AgentLimits => ({
  agent: 'codex',
  plan: 'team',
  windows: [
    { label: '5 h', usedPercent: 42, resetsAt: DEMO_NOW + 2 * HOUR },
    { label: '7 d', usedPercent: 12, resetsAt: DEMO_NOW + 3 * 24 * HOUR },
  ],
  updatedAt,
});

/** Just enough of a stream runner to push one effect through the session service. */
class FakeStream extends EventEmitter<StreamEvents> implements StreamRunnerLike {
  async spawn(opts: StreamSpawnOptions): Promise<{ pid: number }> {
    void opts;
    return { pid: 1 };
  }
  send(): void {}
  respondPermission(): void {}
  setModel(): void {}
  setPermissionMode(): void {}
  setEffort(): void {}
  interrupt(): void {}
  kill(): void {}
  has(): boolean {
    return false;
  }
  killAll(): void {}
  effect(id: string, e: StreamEffect): void {
    this.emit('effect', id, e);
  }
}

let t: TestApp | null = null;
afterEach(async () => {
  await t?.app.shutdown();
  t = null;
});

const limitDeltas = (win: TestApp['win']) =>
  win
    .batches()
    .flatMap((b) => b.deltas)
    .filter((d): d is { op: 'limits.set'; limits: AgentLimits } => d.op === 'limits.set');

describe('UsageService', () => {
  it('starts empty, stamps reports with the main clock, persists them and pushes a limits.set delta', () => {
    t = makeTestApp({ tickMs: 0 });
    const { app, clock, win } = t;
    expect(app.usage.all()).toEqual({});
    expect(app.publisher.snapshot().limits).toEqual({});

    clock.advance(5 * MIN);
    const stored = app.usage.report(codexLimits(0));
    expect(stored.updatedAt).toBe(DEMO_NOW + 5 * MIN);
    expect(app.usage.all()).toEqual({ codex: stored });
    expect(app.repos.settings.kv.get(limitsKey('codex'))).toEqual(stored);
    app.publisher.flush();
    expect(limitDeltas(win)).toEqual([{ op: 'limits.set', limits: stored }]);
    expect(app.publisher.snapshot().limits).toEqual({ codex: stored });

    // A later report for the same agent replaces the earlier one; another agent sits beside it.
    const claude: AgentLimits = {
      agent: 'claude',
      plan: null,
      windows: [{ label: '5 h', usedPercent: 80, resetsAt: null }],
      updatedAt: 0,
    };
    app.usage.report({ ...codexLimits(0), plan: 'pro' });
    app.usage.report(claude);
    expect(Object.keys(app.usage.all()).sort()).toEqual(['claude', 'codex']);
    expect(app.usage.all()['codex']?.plan).toBe('pro');
  });

  it('reloads persisted reports on construction and drops rows it cannot read', () => {
    t = makeTestApp();
    const { app, clock } = t;
    const stored = app.usage.report(codexLimits(0));
    app.repos.settings.kv.set(limitsKey('gemini'), { agent: 'gemini', windows: 'nope' });
    app.repos.settings.kv.set('unrelated', 1);

    const again = new UsageService({ repos: app.repos, publisher: app.publisher, clock });
    expect(again.all()).toEqual({ codex: stored });
    expect(app.repos.settings.kv.get(limitsKey('gemini'))).toBeUndefined();
    expect(app.repos.settings.kv.get('unrelated')).toBe(1);
  });

  it('a limits effect from a running session reaches the service through the session hook', () => {
    const stream = new FakeStream();
    t = makeTestApp({ stream });
    const { app } = t;
    stream.effect(ids.session.claude, {
      type: 'limits',
      limits: {
        agent: 'claude',
        plan: null,
        windows: [{ label: '5 h', usedPercent: 33, resetsAt: DEMO_NOW + HOUR }],
        updatedAt: 0,
      },
    });
    expect(app.usage.all()['claude']).toMatchObject({ agent: 'claude', updatedAt: DEMO_NOW });
    // An effect for a session that does not exist is ignored, as every stream effect is.
    stream.effect('nope', { type: 'limits', limits: codexLimits(0) });
    expect(app.usage.all()['codex']).toBeUndefined();
  });

  describe('refreshLimits', () => {
    const codexCli = (patch: Partial<CliInstall> = {}): CliInstall => ({
      agent: 'codex',
      binary: '/opt/homebrew/bin/codex',
      version: '0.100.0',
      found: true,
      authState: 'signed-in',
      capabilities: { appServer: true },
      checkedAt: DEMO_NOW,
      account: null,
      verifiedAt: null,
      verifyError: null,
      ...patch,
    });

    it('asks Codex through the injected reader and stores what it answers', async () => {
      t = makeTestApp({ tickMs: 0 });
      const { app, clock, win } = t;
      app.repos.discovery.saveCli(codexCli());
      const readCodex = vi.fn(async (bin: string) => {
        expect(bin).toBe('/opt/homebrew/bin/codex');
        return codexLimits(0);
      });
      const usage = new UsageService({ repos: app.repos, publisher: app.publisher, clock, readCodex });
      clock.advance(MIN);
      await usage.refreshLimits();
      expect(readCodex).toHaveBeenCalledTimes(1);
      expect(usage.all()['codex']).toEqual({ ...codexLimits(0), updatedAt: DEMO_NOW + MIN });
      app.publisher.flush();
      expect(limitDeltas(win)).toHaveLength(1);
    });

    it('is a no-op without an installed Codex app-server, and keeps the last report when the reader says nothing or fails', async () => {
      t = makeTestApp();
      const { app, clock } = t;
      const readCodex = vi.fn(async () => null as AgentLimits | null);
      const usage = new UsageService({ repos: app.repos, publisher: app.publisher, clock, readCodex });

      // Not detected at all.
      app.repos.discovery.replaceClis([]);
      await usage.refreshLimits();
      // Detected without the app-server capability.
      app.repos.discovery.saveCli(codexCli({ capabilities: {} }));
      await usage.refreshLimits();
      // Detected but not installed.
      app.repos.discovery.saveCli(codexCli({ found: false, binary: null }));
      await usage.refreshLimits();
      expect(readCodex).not.toHaveBeenCalled();

      app.repos.discovery.saveCli(codexCli());
      const before = usage.report(codexLimits(0));
      await usage.refreshLimits();
      expect(readCodex).toHaveBeenCalledTimes(1);
      expect(usage.all()['codex']).toEqual(before);

      readCodex.mockRejectedValueOnce(new Error('app-server closed'));
      await expect(usage.refreshLimits()).resolves.toBeUndefined();
      expect(usage.all()['codex']).toEqual(before);
    });

    it('shares one in-flight read between concurrent refreshes', async () => {
      t = makeTestApp();
      const { app, clock } = t;
      app.repos.discovery.saveCli(codexCli());
      let release: (v: AgentLimits | null) => void = () => undefined;
      const readCodex = vi.fn(
        () =>
          new Promise<AgentLimits | null>((resolve) => {
            release = resolve;
          }),
      );
      const usage = new UsageService({ repos: app.repos, publisher: app.publisher, clock, readCodex });
      const a = usage.refreshLimits();
      const b = usage.refreshLimits();
      expect(readCodex).toHaveBeenCalledTimes(1);
      release(codexLimits(0));
      await Promise.all([a, b]);
      expect(usage.all()['codex']).toBeDefined();
      // Once settled, the next refresh reads again.
      const c = usage.refreshLimits();
      expect(readCodex).toHaveBeenCalledTimes(2);
      release(null);
      await c;
    });
  });
});
