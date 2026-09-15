import {
  DEFAULT_PROJECT_SETTINGS,
  mergeSettings,
  type AgentChange,
  type EffectiveProjectSettings,
  type ProjectId,
  type ReadModelSnapshot,
  type SessionId,
  type TranscriptMessage,
} from '@styx/core';
import type { Repos } from '../db/repos';

export const TRANSCRIPT_WINDOW = 200;
export const AUDIT_WINDOW = 500;
export const ACTIVITY_WINDOW = 100;

export interface ProjectionDeps {
  repos: Repos;
  /** Pop-out chat windows currently open (WindowService). */
  popouts: () => string[];
  /** Main-owned in-memory rows (RunService / DeployService); absent in tests that only project SQLite. */
  runs?: () => ReadModelSnapshot['runs'];
  deploys?: () => ReadModelSnapshot['deploys'];
}

/** Effective per-project settings: builtin defaults ← app ← `.styx/project.json` overrides stored in `projects.settings_json`. */
export const projectSettingsFor = (repos: Repos, projectId: string): EffectiveProjectSettings =>
  mergeSettings(DEFAULT_PROJECT_SETTINGS, {}, repos.projects.settings(projectId));

/** Builds the full read model from SQLite (plan §8). Called on connect and on a seq gap. */
export function buildSnapshot(deps: ProjectionDeps, seq: number): ReadModelSnapshot {
  const { repos } = deps;
  const transcripts: Record<string, TranscriptMessage[]> = {};
  for (const sid of repos.transcripts.sessionIds())
    transcripts[sid] = repos.transcripts.last(sid, TRANSCRIPT_WINDOW);
  // Hunks ride along only while tracking is on: an installation with thousands of stale rows would otherwise ship
  // every patch in each snapshot for a feature that is off.
  const hunks: Record<string, AgentChange[]> = {};
  if (repos.settings.app().trackAgentEdits)
    for (const sid of repos.agentChanges.sessionIds()) hunks[sid] = repos.agentChanges.bySession(sid);
  const project: Record<string, EffectiveProjectSettings> = {};
  const projects = repos.projects.all();
  for (const p of projects) project[p.id] = projectSettingsFor(repos, p.id);
  return {
    seq,
    projects,
    repos: repos.repos.all(),
    worktrees: repos.worktrees.all(),
    sessions: repos.sessions.all(),
    targets: repos.targets.all(),
    grants: repos.grants.all(),
    auditEntries: repos.audit.recent(AUDIT_WINDOW),
    policies: repos.policies.all(),
    pendingAsks: repos.pendingAsks.all(),
    notifications: repos.notifications.all(),
    transcripts,
    hunks,
    discovery: { ides: repos.discovery.ides(), clis: repos.discovery.clis() },
    settings: { app: repos.settings.app(), project },
    ui: {
      screen: repos.uiState.get<string>('screen') ?? null,
      projectId: repos.uiState.get<ProjectId>('projectId') ?? null,
      projectSession: repos.uiState.get<Record<string, SessionId>>('projectSession') ?? {},
      paneSizes: repos.uiState.get<Record<string, number>>('paneSizes') ?? {},
    },
    popouts: deps.popouts() as SessionId[],
    activity: repos.activity.recent(ACTIVITY_WINDOW),
    runs: deps.runs?.() ?? [],
    deploys: deps.deploys?.() ?? [],
  };
}
