import { z } from 'zod';
import { activityRowSchema } from './model/activity';
import { auditEntrySchema } from './model/audit';
import { sessionIdSchema } from './model/common';
import { cliInstallSchema, ideInstallSchema } from './model/discovery';
import { grantSchema } from './model/grant';
import { agentChangeSchema } from './model/hunk';
import { notificationSchema } from './model/notification';
import { policySchema } from './model/policy';
import { projectSchema, repoSchema, worktreeSchema } from './model/project';
import { pendingAskSchema, sessionSchema, transcriptMessageSchema } from './model/session';
import { appSettingsSchema, projectSettingsSchema, settingsSourceSchema } from './model/settings';
import { targetSchema } from './model/target';
import type { ReadModel, ReadModelTables, TableName } from './read-model';
import { removeRows, upsertRows } from './read-model';

export const effectiveProjectSettingsSchema = z.object(
  Object.fromEntries(
    Object.entries(projectSettingsSchema.shape).map(([k, v]) => [
      k,
      z.object({ value: v, source: settingsSourceSchema }),
    ]),
  ) as {
    [K in keyof typeof projectSettingsSchema.shape]: z.ZodObject<{
      value: (typeof projectSettingsSchema.shape)[K];
      source: typeof settingsSourceSchema;
    }>;
  },
);

const upsertFor = <N extends TableName, S extends z.ZodType>(table: N, row: S) =>
  z.object({ op: z.literal('upsert'), table: z.literal(table), rows: z.array(row) });

export const deltaSchema = z.discriminatedUnion('op', [
  z.discriminatedUnion('table', [
    upsertFor('projects', projectSchema),
    upsertFor('repos', repoSchema),
    upsertFor('worktrees', worktreeSchema),
    upsertFor('sessions', sessionSchema),
    upsertFor('targets', targetSchema),
    upsertFor('grants', grantSchema),
    upsertFor('auditEntries', auditEntrySchema),
    upsertFor('policies', policySchema),
    upsertFor('pendingAsks', pendingAskSchema),
    upsertFor('notifications', notificationSchema),
  ]),
  z.object({
    op: z.literal('remove'),
    table: z.enum([
      'projects',
      'repos',
      'worktrees',
      'sessions',
      'targets',
      'grants',
      'auditEntries',
      'policies',
      'pendingAsks',
      'notifications',
    ]),
    ids: z.array(z.string().min(1)),
  }),
  z.object({
    op: z.literal('transcript.append'),
    sessionId: sessionIdSchema,
    messages: z.array(transcriptMessageSchema),
  }),
  z.object({
    op: z.literal('transcript.patch'),
    sessionId: sessionIdSchema,
    messageId: z.string().min(1),
    /** Streaming text (≤30 Hz): replaces the message body. */
    body: z.string(),
  }),
  z.object({
    op: z.literal('transcript.replace'),
    sessionId: sessionIdSchema,
    messages: z.array(transcriptMessageSchema),
  }),
  z.object({ op: z.literal('hunks.replace'), sessionId: sessionIdSchema, hunks: z.array(agentChangeSchema) }),
  z.object({
    op: z.literal('discovery.set'),
    ides: z.array(ideInstallSchema),
    clis: z.array(cliInstallSchema),
  }),
  z.object({
    op: z.literal('settings.set'),
    app: appSettingsSchema.optional(),
    project: z.record(z.string(), effectiveProjectSettingsSchema).optional(),
  }),
  z.object({ op: z.literal('popouts.set'), sessionIds: z.array(sessionIdSchema) }),
  /** Prepends rows not already present (by id); main keeps the feed capped. */
  z.object({ op: z.literal('activity.append'), rows: z.array(activityRowSchema) }),
]);
export type Delta = z.infer<typeof deltaSchema>;

export const deltaBatchSchema = z.object({
  seq: z.number().int().nonnegative(),
  deltas: z.array(deltaSchema),
});
export type DeltaBatch = z.infer<typeof deltaBatchSchema>;

type Tables = { [N in TableName]: ReadModelTables[N] };

const applyUpsert = (model: ReadModel, delta: Extract<Delta, { op: 'upsert' }>): ReadModel => {
  const table = delta.table;
  const next = upsertRows(model[table] as never, delta.rows as never) as Tables[typeof table];
  return next === model[table] ? model : { ...model, [table]: next };
};

/** Pure, structural-sharing reducer; applying the same delta twice yields an equal model. */
export const applyDelta = (model: ReadModel, delta: Delta): ReadModel => {
  switch (delta.op) {
    case 'upsert':
      return applyUpsert(model, delta);
    case 'remove': {
      const next = removeRows(model[delta.table] as never, delta.ids) as Tables[typeof delta.table];
      return next === model[delta.table] ? model : { ...model, [delta.table]: next };
    }
    case 'transcript.append': {
      const existing = model.transcripts[delta.sessionId] ?? [];
      const seen = new Set(existing.map((m) => m.id));
      const fresh = delta.messages.filter((m) => !seen.has(m.id));
      if (fresh.length === 0) return model;
      return { ...model, transcripts: { ...model.transcripts, [delta.sessionId]: [...existing, ...fresh] } };
    }
    case 'transcript.patch': {
      const existing = model.transcripts[delta.sessionId] ?? [];
      const idx = existing.findIndex((m) => m.id === delta.messageId);
      const current = existing[idx];
      if (current === undefined || current.body === delta.body) return model;
      const patched = [...existing];
      patched[idx] = { ...current, body: delta.body };
      return { ...model, transcripts: { ...model.transcripts, [delta.sessionId]: patched } };
    }
    case 'transcript.replace':
      return { ...model, transcripts: { ...model.transcripts, [delta.sessionId]: delta.messages } };
    case 'hunks.replace':
      return { ...model, hunks: { ...model.hunks, [delta.sessionId]: delta.hunks } };
    case 'discovery.set':
      return { ...model, discovery: { ides: delta.ides, clis: delta.clis } };
    case 'settings.set':
      return {
        ...model,
        settings: {
          app: delta.app ?? model.settings.app,
          project:
            delta.project === undefined
              ? model.settings.project
              : { ...model.settings.project, ...delta.project },
        },
      };
    case 'popouts.set':
      return { ...model, popouts: delta.sessionIds };
    case 'activity.append': {
      const seen = new Set(model.activity.map((r) => r.id));
      const fresh = delta.rows.filter((r) => !seen.has(r.id));
      return fresh.length === 0 ? model : { ...model, activity: [...fresh, ...model.activity] };
    }
  }
};

export const applyDeltas = (model: ReadModel, batch: DeltaBatch): ReadModel => {
  const next = batch.deltas.reduce(applyDelta, model);
  return next === model && batch.seq === model.seq ? model : { ...next, seq: batch.seq };
};

/** True when a batch cannot be applied in order; the renderer must resync via `store.snapshot`. */
export const hasSeqGap = (model: Pick<ReadModel, 'seq'>, batch: Pick<DeltaBatch, 'seq'>): boolean =>
  batch.seq !== model.seq + 1;
