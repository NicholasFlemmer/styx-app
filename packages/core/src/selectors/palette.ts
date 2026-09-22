import type { AskId, ProjectId, SessionId, TargetId, WorktreeId } from '../ids';
import { copy, fill } from '../copy';
import type { Provider } from '../model/common';
import type { Target } from '../model/target';
import { isDeployActive } from '../model/run';
import type { ReadModel } from '../read-model';
import { rows } from '../read-model';
import {
  agentLabel,
  headAskOf,
  liveSessions,
  projectBranch,
  projectHasGit,
  projectNameOf,
  projectSettingsOfOrDefault,
  projectWorktreeOf,
} from './common-settings';
import { formatCountdown } from './format';
import { fuzzyBest } from './fuzzy';
import { targetDerivedState } from './target-state';

export type PaletteScope = 'all' | 'actions' | 'agents' | 'projects';
export const PALETTE_SCOPES: readonly PaletteScope[] = ['all', 'actions', 'agents', 'projects'];

/** ⇥ cycles scope. */
const NEXT_SCOPE: Record<PaletteScope, PaletteScope> = {
  all: 'actions',
  actions: 'agents',
  agents: 'projects',
  projects: 'all',
};
export const nextPaletteScope = (scope: PaletteScope): PaletteScope => NEXT_SCOPE[scope];

export type PaletteAction =
  | { kind: 'deploy'; projectId: ProjectId; targetId: TargetId }
  | { kind: 'review-ask'; sessionId: SessionId; askId: AskId }
  | { kind: 'spawn'; projectId: ProjectId }
  | { kind: 'new-project' }
  /** Owner additions: the recents/scan list, an existing repo (folder picker) or a clone, like the rail menu. */
  | { kind: 'add-existing' }
  | { kind: 'open-folder' }
  | { kind: 'clone-url' }
  | { kind: 'agent-dock' }
  | { kind: 'debt-audit'; projectId: ProjectId }
  /** Commit, push and PR in one step for the worktree the project is on (ADR-0021). */
  | { kind: 'publish'; projectId: ProjectId; worktreeId: WorktreeId }
  | { kind: 'open-session'; sessionId: SessionId }
  | { kind: 'switch-project'; projectId: ProjectId };

export interface PaletteItem {
  id: string;
  /** ▲ deploy · ◆ grant · + spawn · ■ project/new · ● agent */
  glyph: '▲' | '◆' | '+' | '■' | '●';
  label: string;
  meta: string;
  /** The preselected (inverted) row. */
  first: boolean;
  action: PaletteAction;
}

export interface PaletteGroup {
  key: Exclude<PaletteScope, 'all'>;
  label: string;
  items: PaletteItem[];
}

export interface PaletteUi {
  projectId: ProjectId | null;
  /** The chat tab the person is on: Publish offers that lane (what the editor column shows). */
  sessionId?: SessionId | null;
}

/** Providers with a built-in deploy verb (`adapter.deployCommand`). */
export const DEPLOYABLE_PROVIDERS: readonly Provider[] = ['vercel'];

/** The user's own deploy command for a target (`config.deployCommand`), or null when none is set. */
export const deployCommandOf = (t: Pick<Target, 'config'>): string | null => {
  const v = t.config['deployCommand'];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
};

/**
 * A target Styx can deploy to: a provider with a built-in verb, or any target the user gave a deploy command
 * (owner request: GCP / AWS / SSH targets were "permanently greyed out" because only Vercel had a verb).
 */
export const isDeployableTarget = (t: Pick<Target, 'provider' | 'config'>): boolean =>
  DEPLOYABLE_PROVIDERS.includes(t.provider) || deployCommandOf(t) !== null;

const lockMeta = (model: ReadModel, targetId: TargetId, now: number): string => {
  // A deploy already running for this target is the thing to know before pressing Enter on the row again.
  for (const d of Object.values(model.deploys)) {
    if (d.targetId === targetId && isDeployActive(d)) return copy.deploy.inFlight;
  }
  const state = targetDerivedState(model, targetId, now);
  switch (state.kind) {
    case 'open':
      return fill(copy.palette.meta.open, { t: formatCountdown(state.openUntil - now) });
    case 'persistent':
      return copy.palette.meta.always;
    case 'locked':
      return copy.palette.meta.locked;
    case 'expired':
      return copy.palette.meta.expired;
    case 'unconnected':
      return copy.palette.meta.unconnected;
  }
};

const stateMeta = (state: string): string => (state === 'needs-you' ? copy.palette.meta.needsYou : state);

const actionItems = (model: ReadModel, ui: PaletteUi, now: number): PaletteItem[] => {
  const items: PaletteItem[] = [];
  const projectId = ui.projectId;
  if (projectId !== null) {
    const project = projectNameOf(model, projectId);
    // Every target of the project, not only the ones with a deploy verb or a learned command: a row for a target
    // Styx cannot deploy to yet hands the first deploy to the agent (owner principle, AI-native).
    for (const t of rows(model.targets)) {
      if (t.projectId !== projectId) continue;
      items.push({
        id: `deploy:${t.id}`,
        glyph: '▲',
        label: fill(copy.palette.actions.deploy, { project, target: `${t.name} ${t.env}` }),
        meta: lockMeta(model, t.id, now),
        first: false,
        action: { kind: 'deploy', projectId, targetId: t.id },
      });
    }
    for (const s of liveSessions(model).filter((s) => !s.purpose)) {
      if (s.projectId !== projectId || s.state !== 'needs-you') continue;
      const ask = headAskOf(model, s.id);
      if (ask === null || ask.kind !== 'grant' || ask.grantId === null) continue;
      const grant = model.grants.byId[ask.grantId];
      const target = grant === undefined ? undefined : model.targets.byId[grant.targetId];
      if (target === undefined) continue;
      items.push({
        id: `grant:${ask.id}`,
        glyph: '◆',
        label: fill(copy.palette.actions.grant, {
          agent: agentLabel(s),
          target: `${target.name} ${target.env}`,
        }),
        meta: copy.palette.meta.needsYou,
        first: false,
        action: { kind: 'review-ask', sessionId: s.id, askId: ask.id },
      });
    }
    items.push({
      id: `spawn:${projectId}`,
      glyph: '+',
      label: fill(copy.palette.actions.spawn, { project }),
      meta: fill(copy.palette.actions.spawnMeta, {
        agent: projectSettingsOfOrDefault(model, projectId).defaultAgent,
      }),
      first: false,
      action: { kind: 'spawn', projectId },
    });
  }
  items.push({
    id: 'new-project',
    glyph: '■',
    label: copy.palette.actions.newProject,
    meta: copy.palette.actions.newProjectMeta,
    first: false,
    action: { kind: 'new-project' },
  });
  items.push({
    id: 'add-existing',
    glyph: '■',
    label: copy.palette.actions.addExisting,
    meta: copy.palette.actions.addExistingMeta,
    first: false,
    action: { kind: 'add-existing' },
  });
  items.push({
    id: 'open-folder',
    glyph: '■',
    label: copy.palette.actions.openFolder,
    meta: copy.palette.actions.openFolderMeta,
    first: false,
    action: { kind: 'open-folder' },
  });
  items.push({
    id: 'clone-url',
    glyph: '■',
    label: copy.palette.actions.cloneUrl,
    meta: copy.palette.actions.cloneUrlMeta,
    first: false,
    action: { kind: 'clone-url' },
  });
  if (projectId !== null)
    items.push({
      id: 'debt-audit',
      glyph: '▲',
      label: copy.debtAudit.action,
      meta: copy.palette.actions.debtAuditMeta,
      first: false,
      action: { kind: 'debt-audit', projectId },
    });
  // Publish the branch the project is on (a plain folder has no branch to push).
  const wt = projectId === null ? null : projectWorktreeOf(model, projectId, ui.sessionId ?? null);
  if (projectId !== null && wt !== null && wt.branch !== null && projectHasGit(model, projectId))
    items.push({
      id: `publish:${wt.id}`,
      glyph: '▲',
      label: fill(copy.palette.actions.publish, {
        project: projectNameOf(model, projectId),
        branch: wt.branch,
      }),
      meta: copy.palette.actions.publishMeta,
      first: false,
      action: { kind: 'publish', projectId, worktreeId: wt.id },
    });
  items.push({
    id: 'agent-dock',
    glyph: '■',
    label: copy.chat.agentDock.open,
    meta: copy.palette.actions.agentDockMeta,
    first: false,
    action: { kind: 'agent-dock' },
  });
  return items;
};

const agentItems = (model: ReadModel): PaletteItem[] =>
  liveSessions(model)
    .filter((s) => !s.purpose)
    .filter((s) => s.state !== 'done')
    .map((s) => ({
      id: `session:${s.id}`,
      glyph: '●',
      label: `${agentLabel(s)} · ${projectNameOf(model, s.projectId)}`,
      meta: stateMeta(s.state),
      first: false,
      action: { kind: 'open-session', sessionId: s.id },
    }));

const projectItems = (model: ReadModel): PaletteItem[] =>
  rows(model.projects)
    .filter((p) => p.removedAt === null)
    .map((p) => ({
      id: `project:${p.id}`,
      glyph: '■',
      label: fill(copy.palette.actions.switchProject, { project: p.name }),
      meta: projectBranch(model, p.id),
      first: false,
      action: { kind: 'switch-project', projectId: p.id },
    }));

const rank = (items: PaletteItem[], query: string): PaletteItem[] => {
  if (query.trim().length === 0) return items;
  return items
    .map((item, index) => ({ item, index, score: fuzzyBest(query, [item.label, item.meta]) }))
    .filter((x): x is { item: PaletteItem; index: number; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
};

/**
 * Groups Actions / Agents / Projects, fuzzy on label + meta, first row flagged, empty groups dropped,
 * scope filtering (⇥). Lock state lives in each action's meta.
 */
export const paletteResults = (
  model: ReadModel,
  ui: PaletteUi,
  query: string,
  scope: PaletteScope,
  now: number,
): PaletteGroup[] => {
  const all: PaletteGroup[] = [
    { key: 'actions', label: copy.palette.groups.actions, items: actionItems(model, ui, now) },
    { key: 'agents', label: copy.palette.groups.agents, items: agentItems(model) },
    { key: 'projects', label: copy.palette.groups.projects, items: projectItems(model) },
  ];
  let first = true;
  return all
    .filter((g) => scope === 'all' || g.key === scope)
    .map((g) => ({ ...g, items: rank(g.items, query) }))
    .filter((g) => g.items.length > 0)
    .map((g) => ({
      ...g,
      items: g.items.map((item) => {
        const flagged = { ...item, first };
        first = false;
        return flagged;
      }),
    }));
};

export const flattenPalette = (groups: readonly PaletteGroup[]): PaletteItem[] =>
  groups.flatMap((g) => g.items);
