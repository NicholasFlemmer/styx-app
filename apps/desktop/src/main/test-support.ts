import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtures } from '@styx/core';
import { ManualClock } from './clock';
import { buildContainer, type Container, type WindowsPort } from './container';
import { migrate } from './db/migrate';
import { loadFixture, seed, type FixtureName } from './db/seed';
import { MemoryVault } from './services/credential-vault';
import { FakeMfaProvider, type MfaResult } from './services/mfa-service';
import { EVENT_CHANNEL, type WindowLike } from './store/publisher';

/** Records everything main would `webContents.send`. */
export class FakeWindow implements WindowLike {
  readonly sent: { channel: string; payload: unknown }[] = [];
  destroyed = false;
  constructor(readonly id: number) {}
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  events(name: string): unknown[] {
    return this.sent
      .filter((m) => m.channel === EVENT_CHANNEL && (m.payload as { name: string }).name === name)
      .map((m) => (m.payload as { payload: unknown }).payload);
  }
  batches(): { seq: number; deltas: { op: string }[] }[] {
    return this.sent
      .filter((m) => m.channel === 'styx:store')
      .map((m) => m.payload as { seq: number; deltas: { op: string }[] });
  }
}

export interface TestApp {
  app: Container;
  clock: ManualClock;
  vault: MemoryVault;
  win: FakeWindow;
  userData: string;
  sender: { senderId: number; frameUrl: string };
  popouts: string[];
}

export interface TestAppOptions {
  fixture?: FixtureName | null;
  now?: number;
  mfa?: MfaResult;
  fetch?: typeof fetch;
  tickMs?: number;
}

/** An in-memory app: SQLite `:memory:`, MemoryVault, FakeMfa, no Electron, one registered fake window. */
export function makeTestApp(opts: TestAppOptions = {}): TestApp {
  const db = new Database(':memory:');
  migrate(db);
  const clock = new ManualClock(opts.now ?? fixtures.DEMO_NOW);
  const vault = new MemoryVault();
  const userData = mkdtempSync(join(tmpdir(), 'styx-test-'));
  const popouts: string[] = [];
  const windows: WindowsPort = {
    popoutSessionIds: () => popouts,
    openPopout: (id) => {
      if (!popouts.includes(id)) popouts.push(id);
    },
    dockPopout: (id) => {
      const i = popouts.indexOf(id);
      if (i >= 0) popouts.splice(i, 1);
    },
    control: () => undefined,
    focusMain: () => undefined,
  };
  const app = buildContainer({
    db,
    clock,
    vault,
    mfaProvider: new FakeMfaProvider(opts.mfa ?? 'ok'),
    runtime: {
      userData,
      platform: process.platform,
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
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.tickMs !== undefined ? { tickMs: opts.tickMs } : {}),
  });
  const fixture = opts.fixture === undefined ? 'demo' : opts.fixture;
  if (fixture) seed(app.repos, loadFixture(fixture));
  const win = new FakeWindow(1);
  app.publisher.register(win);
  return {
    app,
    clock,
    vault,
    win,
    userData,
    sender: { senderId: 1, frameUrl: 'file:///index.html' },
    popouts,
  };
}
