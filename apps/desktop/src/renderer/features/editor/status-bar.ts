import {
  copy,
  fill,
  headAskOf,
  isDeployActive,
  rows,
  sessionsInProject,
  targetDerivedState,
  type DevRun,
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

/**
 * Status-bar item for the project's local run (owner addition): `dev · http://localhost:5173` once the server
 * printed its URL, `dev · running` before that; nothing once it exited (the strip under the design bar says so).
 */
export const statusBarRun = (run: DevRun | null): string[] => {
  if (run === null || run.phase === 'exited') return [];
  return [
    run.url === null
      ? copy.workspace.run.statusBarNoUrl
      : fill(copy.workspace.run.statusBar, { url: run.url }),
  ];
};

/** `deploying · Vercel prod` for every deploy in flight for one of the project's targets. */
export const statusBarDeploy = (model: ReadModel, projectId: ProjectId): string[] =>
  Object.values(model.deploys)
    .filter((d) => d.projectId === projectId && isDeployActive(d))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((d) => {
      const t = model.targets.byId[d.targetId];
      return fill(copy.deploy.statusBar, { target: t === undefined ? '' : `${t.name} ${t.env}` });
    });

export const editorStatusLabel = (eol: 'lf' | 'crlf', lang: string): string =>
  fill(copy.workspace.editorStatus, { eol: eol.toUpperCase(), lang });

export interface EditorReadout {
  cursor: { line: number; col: number } | null;
  wrap: boolean;
  readOnly: 'binary' | 'large' | null;
}

/**
 * Extra status-bar items to the RIGHT of the prototype's `Monaco · LF · TS` (owner addition, discrepancies #58):
 * `Ln 12, Col 4` · `Wrap` · a read-only notice. Nothing is shown without an open file, so the baked baseline
 * (fixture workspace, no cursor reported yet) is unchanged.
 */
export const editorReadoutItems = (r: EditorReadout): string[] => {
  const out: string[] = [];
  if (r.cursor !== null)
    out.push(fill(copy.workspace.editorCursor, { line: String(r.cursor.line), col: String(r.cursor.col) }));
  if (r.wrap) out.push(copy.workspace.editorWrap);
  if (r.readOnly !== null) out.push(copy.workspace.editorReadOnly[r.readOnly]);
  return out;
};
