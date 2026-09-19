import { z } from 'zod';
import { projectIdSchema, repoIdSchema, sessionIdSchema, timestampSchema, worktreeIdSchema } from './common';

export const projectSchema = z.object({
  id: projectIdSchema,
  name: z.string().min(1),
  path: z.string().min(1),
  initials: z.string().min(1).max(3),
  railOrder: z.number().int(),
  /** Whether a `.styx/project.json` was found; its parsed settings live in ReadModel.settings.project. */
  hasProjectFile: z.boolean(),
  createdAt: timestampSchema,
  lastActivityAt: timestampSchema.nullable(),
  removedAt: timestampSchema.nullable(),
});
export type Project = z.infer<typeof projectSchema>;

export const lineEndingsSchema = z.enum(['auto', 'lf', 'crlf']);
export type LineEndings = z.infer<typeof lineEndingsSchema>;

export const repoRemoteSchema = z.object({ name: z.string(), url: z.string() });
export type RepoRemote = z.infer<typeof repoRemoteSchema>;

/**
 * One repo row per project, git or not. A folder added as-is (no `.git`) keeps `defaultBranch: null`, no remotes and
 * a single main worktree whose `branch` is null; that null is the whole "has git" flag (see `repoHasGit`), so no extra
 * column exists. `project.gitInit` fills both in.
 */
export const repoSchema = z.object({
  id: repoIdSchema,
  projectId: projectIdSchema,
  defaultBranch: z.string().min(1).nullable(),
  remotes: z.array(repoRemoteSchema),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  fetchedAt: timestampSchema.nullable(),
  lineEndings: lineEndingsSchema,
  longPaths: z.boolean(),
});
export type Repo = z.infer<typeof repoSchema>;

/** Whether the project's folder is a git repository (worktrees, diffs and reviews need it). */
export const repoHasGit = (repo: Pick<Repo, 'defaultBranch'> | null | undefined): boolean =>
  repo !== null && repo !== undefined && repo.defaultBranch !== null;

export const prStateSchema = z.enum(['draft', 'open', 'merged', 'closed']);
export type PrState = z.infer<typeof prStateSchema>;

export const worktreeOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('session'), sessionId: sessionIdSchema }),
]);
export type WorktreeOwner = z.infer<typeof worktreeOwnerSchema>;

export const worktreePrSchema = z.object({
  number: z.number().int().positive(),
  state: prStateSchema,
  url: z.string().nullable(),
});
export type WorktreePr = z.infer<typeof worktreePrSchema>;

export const worktreeConflictSchema = z.object({ file: z.string(), against: z.string() });
export type WorktreeConflict = z.infer<typeof worktreeConflictSchema>;

/**
 * Another live lane that changed the same files (owner addition, ADR-0025 "lanes that know about each other").
 * Advisory: refreshed by the lane ledger on every hunk rescan and lane refresh; never a lock.
 */
export const worktreeOverlapSchema = z.object({
  worktreeId: worktreeIdSchema,
  files: z.array(z.string().min(1)),
});
export type WorktreeOverlap = z.infer<typeof worktreeOverlapSchema>;

export const worktreeSchema = z.object({
  id: worktreeIdSchema,
  repoId: repoIdSchema,
  projectId: projectIdSchema,
  /** Null only on the main worktree of a plain (non-git) folder. */
  branch: z.string().min(1).nullable(),
  path: z.string().min(1),
  isMain: z.boolean(),
  owner: worktreeOwnerSchema,
  baseCommit: z.string().nullable(),
  headCommit: z.string().nullable(),
  changes: z.object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
  }),
  pr: worktreePrSchema.nullable(),
  conflict: worktreeConflictSchema.nullable(),
  /** Commits on the project's base branch this lane has not merged in yet (`worktree.fetch` / `worktree.sync`). */
  behindBase: z.number().int().nonnegative().default(0),
  /** Other live lanes that changed files this lane changed too (ADR-0025). */
  overlaps: z.array(worktreeOverlapSchema).default([]),
  mergedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  archivedAt: timestampSchema.nullable(),
});
export type Worktree = z.infer<typeof worktreeSchema>;
