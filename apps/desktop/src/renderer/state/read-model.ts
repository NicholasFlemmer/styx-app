import {
  applyDeltas as applyDeltasPure,
  DEFAULT_APP_SETTINGS,
  emptyReadModel,
  hasSeqGap,
  tableFrom,
  type DeltaBatch,
  type ReadModel,
  type ReadModelSnapshot,
} from '@styx/core';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export type ConnectionState = 'connecting' | 'connected' | 'fixture';

export interface ReadModelStore {
  /** Mirrored read model; main is the source of truth (CLAUDE.md architecture rules). */
  model: ReadModel;
  /** Last applied delta sequence (mirrors `model.seq`). */
  seq: number;
  connection: ConnectionState;
  connected: boolean;
  applySnapshot(snapshot: ReadModelSnapshot): void;
  /** Applies a batch in order; returns `'gap'` (and leaves the model untouched) when the seq is not `seq + 1`. */
  applyDeltas(batch: DeltaBatch): 'applied' | 'gap';
  /** DEV ONLY: hydrate from a core fixture when no main process is attached. */
  replaceModel(model: ReadModel, connection: ConnectionState): void;
  setConnection(connection: ConnectionState): void;
}

/** Arrays over the wire → normalised `Table`s (plan §8). */
export const snapshotToModel = (snapshot: ReadModelSnapshot): ReadModel => ({
  seq: snapshot.seq,
  projects: tableFrom(snapshot.projects),
  repos: tableFrom(snapshot.repos),
  worktrees: tableFrom(snapshot.worktrees),
  sessions: tableFrom(snapshot.sessions),
  targets: tableFrom(snapshot.targets),
  grants: tableFrom(snapshot.grants),
  auditEntries: tableFrom(snapshot.auditEntries),
  policies: tableFrom(snapshot.policies),
  pendingAsks: tableFrom(snapshot.pendingAsks),
  notifications: tableFrom(snapshot.notifications),
  transcripts: snapshot.transcripts,
  hunks: snapshot.hunks,
  discovery: snapshot.discovery,
  settings: {
    app: snapshot.settings.app,
    project: snapshot.settings.project,
  },
  popouts: snapshot.popouts,
  activity: snapshot.activity,
  runs: Object.fromEntries(snapshot.runs.map((r) => [r.projectId, r])),
  devices: Object.fromEntries(snapshot.devices.map((d) => [d.projectId, d])),
  deploys: Object.fromEntries(snapshot.deploys.map((d) => [d.deployId, d])),
  checkpoints: snapshot.checkpoints,
  queues: snapshot.queues,
  limits: snapshot.limits,
  account: snapshot.account,
  update: snapshot.update,
  agentSetup: Object.fromEntries(snapshot.agentSetup.map((s) => [s.agent, s])),
});

export const useReadModel = create<ReadModelStore>()(
  immer((set, get) => ({
    model: emptyReadModel(DEFAULT_APP_SETTINGS),
    seq: 0,
    connection: 'connecting',
    connected: false,
    applySnapshot: (snapshot) => {
      const model = snapshotToModel(snapshot);
      set({ model, seq: model.seq, connection: 'connected', connected: true });
    },
    applyDeltas: (batch) => {
      const { model } = get();
      if (hasSeqGap(model, batch)) return 'gap';
      const next = applyDeltasPure(model, batch);
      set({ model: next, seq: next.seq });
      return 'applied';
    },
    replaceModel: (model, connection) =>
      set({ model, seq: model.seq, connection, connected: connection === 'connected' }),
    setConnection: (connection) =>
      set((s) => {
        s.connection = connection;
        s.connected = connection === 'connected';
      }),
  })),
);

export const modelSnapshot = (): ReadModel => useReadModel.getState().model;
