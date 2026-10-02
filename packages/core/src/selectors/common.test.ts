import { describe, expect, it } from 'vitest';
import { demoReadModel, ids, DEMO_NOW } from '../fixtures/demo';
import { idFrom } from '../ids';
import type { Session } from '../model/session';
import { tableFrom, rows } from '../read-model';
import { inLiveProject, liveSessions, sessionsInProject } from './common';
import { backgroundTasks } from './tasks';

describe('a removed project keeps its threads out of sight', () => {
  const removeAcme = () => {
    const model = demoReadModel();
    const acme = model.projects.byId[ids.project.acmeShop];
    if (!acme) throw new Error('fixture');
    return {
      model,
      removed: {
        ...model,
        projects: tableFrom(
          rows(model.projects).map((p) => (p.id === acme.id ? { ...p, removedAt: DEMO_NOW } : p)),
        ),
      },
    };
  };

  it('liveSessions and sessionsInProject drop them while the project is removed', () => {
    const { model, removed } = removeAcme();
    expect(sessionsInProject(model, ids.project.acmeShop).length).toBeGreaterThan(0);
    expect(sessionsInProject(removed, ids.project.acmeShop)).toEqual([]);
    expect(liveSessions(removed).some((s) => s.projectId === ids.project.acmeShop)).toBe(false);
    expect(liveSessions(removed).length).toBeGreaterThan(0);
  });

  it('inLiveProject is false for a removed project and for one the model does not have', () => {
    const { model, removed } = removeAcme();
    expect(inLiveProject(model, { projectId: ids.project.acmeShop })).toBe(true);
    expect(inLiveProject(removed, { projectId: ids.project.acmeShop })).toBe(false);
    expect(inLiveProject(model, { projectId: idFrom<'ProjectId'>('proj_missing') })).toBe(false);
  });

  it('background tasks of a removed project leave the Tasks rail too', () => {
    const { removed } = removeAcme();
    const base = removed.sessions.byId[ids.session.claude];
    if (!base) throw new Error('fixture');
    const task: Session = { ...base, purpose: 'debt-audit' };
    expect(backgroundTasks({ ...removed, sessions: tableFrom([task]) })).toEqual([]);
  });
});
