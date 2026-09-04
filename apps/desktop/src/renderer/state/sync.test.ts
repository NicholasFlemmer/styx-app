// @vitest-environment jsdom
import { fixtures, type DeltaBatch, type ReadModelSnapshot } from '@styx/core';
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
  };
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

interface FakeBridge {
  snapshot: ReturnType<typeof vi.fn>;
  onDelta: (cb: (b: DeltaBatch) => void) => () => void;
  onEvent: () => () => void;
  emit: (b: DeltaBatch) => void;
}

const install = (seqs: number[]): FakeBridge => {
  let listener: ((b: DeltaBatch) => void) | null = null;
  const queue = [...seqs];
  const fake: FakeBridge = {
    snapshot: vi.fn(async () => snapshotOf(queue.shift() ?? 1)),
    onDelta: (cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    onEvent: () => () => {},
    emit: (b) => listener?.(b),
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
