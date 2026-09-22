import type { ProjectId } from '../ids';
import { isLive } from '../machines/grant';
import type { Grant } from '../model/grant';
import type { ReadModel } from '../read-model';
import { rows } from '../read-model';
import { liveSessions } from './common';
import { padCount } from './format';
import { targetDerivedState } from './target-state';

export const needsYouCount = (model: ReadModel): number =>
  liveSessions(model).filter((s) => s.state === 'needs-you').length;

/** Agents working: excludes idle, needs-you, paused and done. */
export const workingCount = (model: ReadModel): number =>
  liveSessions(model).filter((s) => s.state === 'working').length;

/** Targets in the project whose derived state is `locked`. */
/** Targets an agent cannot use right now: `locked` plus `expired` (the prototype's error state counts both). */
export const lockedCount = (model: ReadModel, projectId: ProjectId, now: number): number =>
  rows(model.targets).filter((t) => {
    const kind = targetDerivedState(model, t.id, now).kind;
    return t.projectId === projectId && (kind === 'locked' || kind === 'expired');
  }).length;

/** Live grants across all projects (includes persistent `always` grants). */
export const activeGrants = (model: ReadModel, now: number): Grant[] =>
  rows(model.grants).filter((g) => isLive(g, now));

export const projectCount = (model: ReadModel): number =>
  rows(model.projects).filter((p) => p.removedAt === null).length;

export interface Counter {
  n: string;
  label: string;
}

/** Home counter strip: Needs you · Agents working · Grants active · Projects (zero-padded). */
export const homeCounters = (
  model: ReadModel,
  now: number,
  labels: { needsYou: string; agentsWorking: string; grantsActive: string; projects: string },
): Counter[] => [
  { n: padCount(needsYouCount(model)), label: labels.needsYou },
  { n: padCount(workingCount(model)), label: labels.agentsWorking },
  { n: padCount(activeGrants(model, now).length), label: labels.grantsActive },
  { n: padCount(projectCount(model)), label: labels.projects },
];
