import { describe, expect, it } from 'vitest';
import { demoReadModel, ids, DEMO_NOW } from '../fixtures/demo';
import type { Session } from '../model/session';
import { tableFrom } from '../read-model';
import { activeTask, backgroundTasks, taskKey, taskTitle } from './tasks';

describe('background task selection', () => {
  it('separates jobs by project and deploy target, retaining only unarchived tasks', () => {
    const model = demoReadModel();
    const base = model.sessions.byId[ids.session.claude];
    if (!base) throw new Error('fixture');
    const run: Session = { ...base, purpose: 'learn-run' };
    const deploy: Session = {
      ...base,
      id: ids.session.codex,
      purpose: 'learn-deploy',
      taskTargetId: ids.target.vercelPreview,
    };
    const archived: Session = {
      ...base,
      id: ids.session.gemini,
      purpose: 'debt-audit',
      archivedAt: DEMO_NOW,
    };
    const jobs = { ...model, sessions: tableFrom([run, deploy, archived]) };
    expect(taskKey(run)).toBe(`run:${base.projectId}`);
    expect(taskKey(deploy)).toBe(`deploy:${ids.target.vercelPreview}`);
    expect(activeTask(jobs, taskKey(run))?.id).toBe(run.id);
    expect(activeTask(jobs, `run:${ids.project.blogV2}`)).toBeNull();
    expect(backgroundTasks(jobs).map((s) => s.id)).toEqual([deploy.id, run.id]);
    expect(taskTitle(deploy.purpose, { name: 'Vercel', env: 'preview' })).toBe('Deploy · Vercel preview');
  });

  it('uses the newest task when timestamps tie, and does not reopen a completed task as active', () => {
    const model = demoReadModel();
    const base = model.sessions.byId[ids.session.claude];
    if (!base) throw new Error('fixture');
    const old: Session = { ...base, purpose: 'debt-audit', state: 'done', endedAt: DEMO_NOW, exitCode: 0 };
    const current: Session = { ...base, id: ids.session.codex, purpose: 'debt-audit' };
    const jobs = { ...model, sessions: tableFrom([old, current]) };
    expect(backgroundTasks(jobs)[0]?.id).toBe(current.id);
    expect(activeTask(jobs, taskKey(old))?.id).toBe(current.id);
    expect(activeTask({ ...model, sessions: tableFrom([old]) }, taskKey(old))).toBeNull();
    expect(backgroundTasks(model)).toEqual([]);
  });
});
