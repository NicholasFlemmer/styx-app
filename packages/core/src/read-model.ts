import type { ProjectId, SessionId } from './ids';
import type { ActivityRow } from './model/activity';
import type { AuditEntry } from './model/audit';
import type { CliInstall, IdeInstall } from './model/discovery';
import type { Grant } from './model/grant';
import type { AgentChange } from './model/hunk';
import type { Notification } from './model/notification';
import type { Policy } from './model/policy';
import type { Project, Repo, Worktree } from './model/project';
import type { PendingAsk, Session, TranscriptMessage } from './model/session';
import type { AppSettings, EffectiveProjectSettings } from './model/settings';
import type { Target } from './model/target';

/** Normalised table: `ids` keeps insertion order, `byId` is the lookup. */
export interface Table<T extends { id: string }> {
  byId: Readonly<Record<string, T>>;
  ids: readonly string[];
}

export const emptyTable = <T extends { id: string }>(): Table<T> => ({ byId: {}, ids: [] });

export const tableFrom = <T extends { id: string }>(rows: readonly T[]): Table<T> => {
  const byId: Record<string, T> = {};
  const ids: string[] = [];
  for (const row of rows) {
    if (!(row.id in byId)) ids.push(row.id);
    byId[row.id] = row;
  }
  return { byId, ids };
};

export const rows = <T extends { id: string }>(table: Table<T>): T[] => {
  const out: T[] = [];
  for (const id of table.ids) {
    const row = table.byId[id];
    if (row !== undefined) out.push(row);
  }
  return out;
};

export const upsertRows = <T extends { id: string }>(table: Table<T>, incoming: readonly T[]): Table<T> => {
  if (incoming.length === 0) return table;
  const byId: Record<string, T> = { ...table.byId };
  const ids = [...table.ids];
  for (const row of incoming) {
    if (!(row.id in byId)) ids.push(row.id);
    byId[row.id] = row;
  }
  return { byId, ids };
};

export const removeRows = <T extends { id: string }>(
  table: Table<T>,
  remove: readonly string[],
): Table<T> => {
  const gone = new Set(remove);
  if (!table.ids.some((id) => gone.has(id))) return table;
  const byId: Record<string, T> = {};
  const ids: string[] = [];
  for (const id of table.ids) {
    if (gone.has(id)) continue;
    const row = table.byId[id];
    if (row !== undefined) {
      byId[id] = row;
      ids.push(id);
    }
  }
  return { byId, ids };
};

export interface Discovery {
  ides: readonly IdeInstall[];
  clis: readonly CliInstall[];
}

export interface ReadModelSettings {
  app: AppSettings;
  project: Readonly<Record<string, EffectiveProjectSettings>>;
}

export interface ReadModelTables {
  projects: Table<Project>;
  repos: Table<Repo>;
  worktrees: Table<Worktree>;
  sessions: Table<Session>;
  targets: Table<Target>;
  grants: Table<Grant>;
  auditEntries: Table<AuditEntry>;
  policies: Table<Policy>;
  pendingAsks: Table<PendingAsk>;
  notifications: Table<Notification>;
}

export type TableName = keyof ReadModelTables;
export type RowOf<N extends TableName> = ReadModelTables[N] extends Table<infer T> ? T : never;

/** The renderer's mirrored store (plan §8); main is the source of truth. */
export interface ReadModel extends ReadModelTables {
  /** Last applied delta sequence; a gap triggers `store.snapshot`. */
  seq: number;
  transcripts: Readonly<Record<string, readonly TranscriptMessage[]>>;
  hunks: Readonly<Record<string, readonly AgentChange[]>>;
  discovery: Discovery;
  settings: ReadModelSettings;
  popouts: readonly SessionId[];
  /** Home activity feed rows (main appends; capped there). */
  activity: readonly ActivityRow[];
}

export const TABLE_NAMES: readonly TableName[] = [
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
];

export const emptyReadModel = (app: AppSettings): ReadModel => ({
  seq: 0,
  projects: emptyTable(),
  repos: emptyTable(),
  worktrees: emptyTable(),
  sessions: emptyTable(),
  targets: emptyTable(),
  grants: emptyTable(),
  auditEntries: emptyTable(),
  policies: emptyTable(),
  pendingAsks: emptyTable(),
  notifications: emptyTable(),
  transcripts: {},
  hunks: {},
  discovery: { ides: [], clis: [] },
  settings: { app, project: {} },
  popouts: [],
  activity: [],
});

export const projectSettingsOf = (model: ReadModel, projectId: ProjectId): EffectiveProjectSettings | null =>
  model.settings.project[projectId] ?? null;
