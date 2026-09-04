// @vitest-environment jsdom
import { fixtures, rows, type DeltaBatch, type ReadModelSnapshot } from '@styx/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { snapshotToModel, useReadModel } from './read-model';

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
  };
};

describe('read-model store', () => {
  beforeEach(() => {
    useReadModel.getState().replaceModel(fixtures.emptyReadModel(), 'connecting');
    useReadModel.setState({ seq: 0, connection: 'connecting', connected: false });
  });

  it('normalises a snapshot into tables and marks the store connected', () => {
    const snap = snapshotOf(7);
    useReadModel.getState().applySnapshot(snap);
    const s = useReadModel.getState();
    expect(s.connected).toBe(true);
    expect(s.seq).toBe(7);
    expect(s.model.projects.ids).toEqual(snap.projects.map((p) => p.id));
    expect(rows(s.model.sessions)).toHaveLength(snap.sessions.length);
    expect(snapshotToModel(snap).settings.project).toBe(snap.settings.project);
  });

  it('applies an in-order delta batch and advances seq', () => {
    useReadModel.getState().applySnapshot(snapshotOf(1));
    const project = rows(useReadModel.getState().model.projects)[0];
    if (project === undefined) throw new Error('fixture has no project');
    const batch: DeltaBatch = {
      seq: 2,
      deltas: [{ op: 'upsert', table: 'projects', rows: [{ ...project, name: 'renamed' }] }],
    };
    expect(useReadModel.getState().applyDeltas(batch)).toBe('applied');
    expect(useReadModel.getState().seq).toBe(2);
    expect(useReadModel.getState().model.projects.byId[project.id]?.name).toBe('renamed');
  });

  it('refuses a batch with a seq gap and leaves the model untouched', () => {
    useReadModel.getState().applySnapshot(snapshotOf(1));
    const before = useReadModel.getState().model;
    const batch: DeltaBatch = { seq: 5, deltas: [{ op: 'popouts.set', sessionIds: [] }] };
    expect(useReadModel.getState().applyDeltas(batch)).toBe('gap');
    expect(useReadModel.getState().model).toBe(before);
    expect(useReadModel.getState().seq).toBe(1);
  });
});
