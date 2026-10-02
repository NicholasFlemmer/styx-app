// @vitest-environment jsdom
import { fixtures, type DeltaBatch, type ReadModelSnapshot, UPDATE_OFF } from '@styx/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadModel } from './read-model';
import { connectSync } from './sync';
import { useUiStore } from './ui-store';

const snapshotOf = (seq: number): ReadModelSnapshot => {
  const f = fixtures.demoFixture();
  return {
    seq,
    projects: f.projects,
    repos: f.repos,
    worktrees: f.worktrees,
    sessions: f.sessions,
    targets: f.targets,
    grants: f.grants,
    auditEntries: f.auditEntries,
    policies: f.policies,
    pendingAsks: f.pendingAsks,
    notifications: f.notifications,
    transcripts: f.transcripts,
    hunks: f.hunks,
    discovery: { ides: f.ides, clis: f.clis },
    settings: { app: f.appSettings, project: f.projectSettings },
    popouts: [],
    ui: { screen: null, projectId: null, projectSession: {}, paneSizes: {} },
    activity: f.activity,
    runs: [],
    devices: [],
    deploys: [],
    checkpoints: {},
    queues: {},
    limits: {},
    account: f.account,
    update: UPDATE_OFF,
    agentSetup: [],
  };
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

interface FakeBridge {
  snapshot: ReturnType<typeof vi.fn>;
  onDelta: (cb: (b: DeltaBatch) => void) => () => void;
  onEvent: (name: string, cb: (payload: unknown) => void) => () => void;
  emit: (b: DeltaBatch) => void;
  /** Fires a main → renderer event at every listener registered under `name`. */
  event: (name: string, payload: unknown) => void;
}

const install = (seqs: number[]): FakeBridge => {
  let listener: ((b: DeltaBatch) => void) | null = null;
  const events = new Map<string, ((payload: unknown) => void)[]>();
  const queue = [...seqs];
  const fake: FakeBridge = {
    snapshot: vi.fn(async () => snapshotOf(queue.shift() ?? 1)),
    onDelta: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    onEvent: (name, cb) => {
      events.set(name, [...(events.get(name) ?? []), cb]);
      return () =>
        events.set(
          name,
          (events.get(name) ?? []).filter((f) => f !== cb),
        );
    },
    emit: (b) => listener?.(b),
    event: (name, payload) => {
      for (const cb of events.get(name) ?? []) cb(payload);
    },
  };
  Object.assign(window, { styx: { platform: 'darwin', env: {}, ...fake } });
  return fake;
};

describe('connectSync', () => {
  beforeEach(() => {
    useReadModel.setState({
      model: fixtures.emptyReadModel(),
      seq: 0,
      connection: 'connecting',
      connected: false,
    });
    useUiStore.setState({ screenResolved: false, projectId: null });
  });
  afterEach(() => {
    Object.assign(window, { styx: undefined });
  });

  it('hydrates from the snapshot then applies sequenced deltas', async () => {
    const fake = install([3]);
    const off = connectSync();
    await flush();
    expect(useReadModel.getState().seq).toBe(3);
    expect(useReadModel.getState().connected).toBe(true);
    expect(useUiStore.getState().screenResolved).toBe(true);
    fake.emit({ seq: 4, deltas: [{ op: 'popouts.set', sessionIds: [] }] });
    expect(useReadModel.getState().seq).toBe(4);
    expect(fake.snapshot).toHaveBeenCalledTimes(1);
    off();
  });

  it('resyncs via snapshot on a seq gap and replays queued batches', async () => {
    const fake = install([1, 6]);
    const off = connectSync();
    await flush();
    expect(useReadModel.getState().seq).toBe(1);
    fake.emit({ seq: 5, deltas: [{ op: 'popouts.set', sessionIds: [] }] });
    expect(fake.snapshot).toHaveBeenCalledTimes(2);
    fake.emit({ seq: 7, deltas: [{ op: 'popouts.set', sessionIds: [] }] });
    await flush();
    expect(useReadModel.getState().seq).toBe(7);
    off();
  });

  it("queue.returned puts the returned bodies into that session's composer draft, blank-line separated", async () => {
    const fake = install([1]);
    useUiStore.setState({ drafts: {} });
    const off = connectSync();
    await flush();
    const sessionId = fixtures.ids.session.claude;
    fake.event('queue.returned', { sessionId, bodies: ['alpha', 'beta'] });
    expect(useUiStore.getState().drafts[sessionId]).toMatchObject({ text: 'alpha\n\nbeta' });
    const seq = useUiStore.getState().drafts[sessionId]?.seq ?? 0;
    // A later return lands after what is already waiting, under a fresh seq so the composer applies it.
    fake.event('queue.returned', { sessionId, bodies: ['gamma'] });
    expect(useUiStore.getState().drafts[sessionId]).toEqual({ text: 'alpha\n\nbeta\n\ngamma', seq: seq + 1 });
    fake.event('queue.returned', { sessionId: fixtures.ids.session.codex, bodies: [] });
    expect(useUiStore.getState().drafts[fixtures.ids.session.codex]).toBeUndefined();
    off();
    fake.event('queue.returned', { sessionId, bodies: ['late'] });
    expect(useUiStore.getState().drafts[sessionId]?.text).toBe('alpha\n\nbeta\n\ngamma');
  });

  it('falls back to the demo fixture when main is not attached (dev only)', () => {
    Object.assign(window, { styx: undefined });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    connectSync();
    expect(useReadModel.getState().connection).toBe('fixture');
    expect(useReadModel.getState().model.projects.ids.length).toBeGreaterThan(0);
    expect(useUiStore.getState().projectId).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
