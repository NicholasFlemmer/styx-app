import {
  copy,
  fill,
  headAskOf,
  rows,
  sessionsInProject,
  targetDerivedState,
  type ProjectId,
  type ReadModel,
} from '@styx/core';

/**
 * Status-bar target items (prototype: `Vercel prod · open 58m` · `Supabase · locked`): targets in play for the
 * project — every open grant, plus locked targets an agent is currently waiting on (needs-you head ask).
 * Persistent and untouched locked targets stay out of the bar.
 */
export const statusBarTargets = (model: ReadModel, projectId: ProjectId, now: number): string[] => {
  const waitingOn = new Set<string>();
  for (const s of sessionsInProject(model, projectId)) {
    if (s.state !== 'needs-you') continue;
    const ask = headAskOf(model, s.id);
    if (ask === null || ask.kind !== 'grant' || ask.grantId === null) continue;
    const grant = model.grants.byId[ask.grantId];
    if (grant !== undefined) waitingOn.add(grant.targetId);
  }
  const out: string[] = [];
  for (const t of rows(model.targets)) {
    if (t.projectId !== projectId) continue;
    const state = targetDerivedState(model, t.id, now);
    if (state.kind === 'open') {
      out.push(
        fill(copy.targets.statusBar.open, {
          target: `${t.name} ${t.env}`,
          t: state.label.replace(/^open · | left$/g, ''),
        }),
      );
    } else if (state.kind === 'locked' && waitingOn.has(t.id)) {
      out.push(fill(copy.targets.statusBar.locked, { target: t.name }));
    }
  }
  return out;
};

export const editorStatusLabel = (eol: 'lf' | 'crlf', lang: string): string =>
  fill(copy.workspace.editorStatus, { eol: eol.toUpperCase(), lang });
