import { fixtures, type AgentChange } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../test-support';
import { isPolicyFile } from './hunk-service';

const { ids } = fixtures;

describe('HunkService', () => {
  it('isPolicyFile matches .styx/project.json at any depth on both separators', () => {
    expect(isPolicyFile('.styx/project.json')).toBe(true);
    expect(isPolicyFile('/repo/.styx/project.json')).toBe(true);
    expect(isPolicyFile('C:\\repo\\.styx\\project.json')).toBe(true);
    expect(isPolicyFile('src/.styx/project.json')).toBe(true);
    expect(isPolicyFile('.STYX/Project.JSON')).toBe(true); // case-insensitive filesystems
    expect(isPolicyFile('src/../.styx/./project.json')).toBe(true);
    expect(isPolicyFile('styx/project.json')).toBe(false);
    expect(isPolicyFile('.styx/project.json.bak')).toBe(false);
    expect(isPolicyFile('a.ts')).toBe(false);
  });

  it('H-1: acceptAll skips hunks touching .styx/project.json; they stay pending for an explicit accept', async () => {
    const t = makeTestApp();
    const applied: string[] = [];
    t.app.git.applyPatch = async (_path, patch) => {
      applied.push(patch);
    };
    const now = t.clock.now();
    const base: Omit<AgentChange, 'id' | 'file' | 'hunkHash' | 'patch'> = {
      sessionId: ids.session.claude,
      worktreeId: ids.worktree.fixCheckout,
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
      status: 'pending',
      firstSeenAt: now,
      lastSeenAt: now,
      decidedAt: null,
    };
    const policy: AgentChange = { ...base, id: 'h-policy' as AgentChange['id'], file: '.styx/project.json', hunkHash: 'hp', patch: 'policy-patch' };
    const code: AgentChange = { ...base, id: 'h-code' as AgentChange['id'], file: 'src/a.ts', hunkHash: 'hc', patch: 'code-patch' };
    t.app.repos.agentChanges.upsert(policy);
    t.app.repos.agentChanges.upsert(code);
    const pendingBefore = t.app.repos.agentChanges.bySession(ids.session.claude).filter((h) => h.status === 'pending').length;

    const n = await t.app.hunks.acceptAll(ids.session.claude);
    expect(n).toBe(pendingBefore - 1);
    expect(applied).not.toContain('policy-patch');
    expect(applied).toContain('code-patch');
    expect(t.app.repos.agentChanges.get('h-policy')).toMatchObject({ status: 'pending' });
    expect(t.app.repos.agentChanges.get('h-code')).toMatchObject({ status: 'accepted' });

    // An explicit per-hunk accept still works.
    await t.app.hunks.accept('h-policy');
    expect(t.app.repos.agentChanges.get('h-policy')).toMatchObject({ status: 'accepted' });
    expect(applied).toContain('policy-patch');
  });
});
