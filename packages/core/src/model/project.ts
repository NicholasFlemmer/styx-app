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

export const repoSchema = z.object({
  id: repoIdSchema,
  projectId: projectIdSchema,
  defaultBranch: z.string().min(1),
  remotes: z.array(repoRemoteSchema),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  fetchedAt: timestampSchema.nullable(),
  lineEndings: lineEndingsSchema,
  longPaths: z.boolean(),
});
export type Repo = z.infer<typeof repoSchema>;

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

export const worktreeSchema = z.object({
  id: worktreeIdSchema,
  repoId: repoIdSchema,
  projectId: projectIdSchema,
  branch: z.string().min(1),
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
  mergedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  archivedAt: timestampSchema.nullable(),
});
export type Worktree = z.infer<typeof worktreeSchema>;
