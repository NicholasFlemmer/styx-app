import { z } from 'zod';
import { effortSchema, permissionModeSchema } from './model/session';
import {
  agentSchema,
  authMethodSchema,
  envSchema,
  jsonObjectSchema,
  providerSchema,
  targetPolicySchema,
} from './model/common';
import { policyRuleSchema } from './model/policy';
import { lineEndingsSchema } from './model/project';
import type { EffectiveProjectSettings, ProjectSettings, SettingsSource } from './model/settings';
import { envShareSchema, windowsShellSchema, worktreeLocationSchema } from './model/settings';

export const PROJECT_FILE_SCHEMA_URL = 'https://styx.dev/schema/project.v1.json';
export const PROJECT_FILE_PATH = '.styx/project.json';

/**
 * Target names travel into shell-adjacent places (audit labels, MFA prompt reasons, shim `list_targets`), so they
 * are limited to a plain charset: letters, digits, space, `. _ / @ : + -`, 1–80 chars.
 */
export const TARGET_NAME_PATTERN = /^[A-Za-z0-9 ._/@:+-]{1,80}$/;
export const targetNameSchema = z
  .string()
  .regex(TARGET_NAME_PATTERN, 'target name: letters, digits, space, . _ / @ : + - only (max 80)');

export const projectFileTargetSchema = z
  .object({
    name: targetNameSchema,
    provider: providerSchema,
    env: envSchema,
    authMethod: authMethodSchema,
    config: jsonObjectSchema.optional(),
    policy: targetPolicySchema.optional(),
  })
  .passthrough();
export type ProjectFileTarget = z.infer<typeof projectFileTargetSchema>;

export const projectFileAgentsSchema = z
  .object({
    default: agentSchema.optional(),
    model: z.string().nullable().optional(),
    permissionMode: permissionModeSchema.optional(),
    effort: effortSchema.nullable().optional(),
    autoApproveEdits: z.boolean().optional(),
    mayRequestTargets: z.boolean().optional(),
    notifyWhenNeedsMe: z.boolean().optional(),
    perAgent: z
      .partialRecord(agentSchema, z.object({ model: z.string().nullable().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

/** Rule ids land in audit rows and `ui_state`; keep them plain and short. */
export const PROJECT_POLICY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
export const projectFilePolicySchema = z
  .object({
    id: z.string().regex(PROJECT_POLICY_ID_PATTERN, 'policy id: letters, digits, . _ : - only (max 64)'),
    rule: policyRuleSchema,
    ruleText: z.string().min(1).max(200),
    enabled: z.boolean().optional(),
  })
  .passthrough();
export type ProjectFilePolicy = z.infer<typeof projectFilePolicySchema>;

/**
 * `.styx/project.json` v1 (plan §4, ADR-0005). Committed, secret-free. Unknown keys pass through so a
 * rewrite never drops fields written by a newer Styx.
 */
export const projectFileV1Schema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    name: z.string().min(1),
    targets: z.array(projectFileTargetSchema).optional(),
    agents: projectFileAgentsSchema.optional(),
    policies: z
      .object({
        disabledBuiltins: z.array(z.string()).optional(),
        extra: z.array(projectFilePolicySchema).optional(),
      })
      .passthrough()
      .optional(),
    worktrees: z
      .object({
        baseBranch: z.string().min(1).optional(),
        branchPrefix: z.string().optional(),
        location: worktreeLocationSchema.optional(),
      })
      .passthrough()
      .optional(),
    shell: z.object({ windows: windowsShellSchema.optional() }).passthrough().optional(),
    lineEndings: lineEndingsSchema.optional(),
    /** Dev-server URL and run command for the design window; they describe the project, so they travel with the repo. */
    dev: z.object({ url: z.string().optional(), command: z.string().optional() }).passthrough().optional(),
    env: z
      .object({
        files: z.array(z.string()).optional(),
        shareWithAgents: envShareSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ProjectFileV1 = z.infer<typeof projectFileV1Schema>;

export type ProjectFileParseResult =
  | { ok: true; file: ProjectFileV1 }
  | { ok: false; error: { code: 'invalid-json' | 'invalid-schema' | 'newer-version'; message: string } };

const SECRET_KEY = /(secret|token|password|passphrase|private[_-]?key|credential)/i;

/** Keys that look like secrets are rejected: the file is committed. */
const findSecretKey = (value: unknown, path: string[] = []): string | null => {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findSecretKey(value[i], [...path, String(i)]);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) && k !== 'credentialRef') return [...path, k].join('.');
      const hit = findSecretKey(v, [...path, k]);
      if (hit !== null) return hit;
    }
  }
  return null;
};

export const parseProjectFile = (text: string): ProjectFileParseResult => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: { code: 'invalid-json', message: e instanceof Error ? e.message : 'invalid JSON' },
    };
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const version = (raw as { version?: unknown }).version;
    if (typeof version === 'number' && version > 1) {
      return {
        ok: false,
        error: {
          code: 'newer-version',
          message: `project.json version ${version} is newer than this Styx supports (1)`,
        },
      };
    }
  }
  const secret = findSecretKey(raw);
  if (secret !== null) {
    return {
      ok: false,
      error: {
        code: 'invalid-schema',
        message: `secret-like key "${secret}" is not allowed in ${PROJECT_FILE_PATH}`,
      },
    };
  }
  const parsed = projectFileV1Schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: { code: 'invalid-schema', message: z.prettifyError(parsed.error) } };
  }
  return { ok: true, file: parsed.data };
};

const KEY_ORDER = [
  '$schema',
  'version',
  'name',
  'targets',
  'agents',
  'policies',
  'worktrees',
  'shell',
  'lineEndings',
  'dev',
  'env',
];
const TARGET_KEY_ORDER = ['name', 'provider', 'env', 'authMethod', 'config', 'policy'];

const orderKeys = (obj: Record<string, unknown>, order: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of order) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj).sort()) if (!(k in out)) out[k] = obj[k];
  return out;
};

/** Stable key order (known keys first in canonical order, unknown keys after, sorted), 2-space indent, trailing newline. */
export const serializeProjectFile = (file: ProjectFileV1): string => {
  const base: Record<string, unknown> = { $schema: PROJECT_FILE_SCHEMA_URL, ...file };
  if (Array.isArray(base['targets'])) {
    base['targets'] = (base['targets'] as Record<string, unknown>[]).map((t) =>
      orderKeys(t, TARGET_KEY_ORDER),
    );
  }
  return `${JSON.stringify(orderKeys(base, KEY_ORDER), null, 2)}\n`;
};

/** The subset of ProjectSettings a project file sets explicitly. */
export const projectSettingsFromFile = (file: ProjectFileV1): Partial<ProjectSettings> => {
  const out: Partial<ProjectSettings> = {};
  const a = file.agents;
  if (a?.default !== undefined) out.defaultAgent = a.default;
  if (a?.model !== undefined) out.model = a.model;
  if (a?.permissionMode !== undefined) out.permissionMode = a.permissionMode;
  if (a?.effort !== undefined) out.effort = a.effort;
  if (a?.autoApproveEdits !== undefined) out.autoApproveEdits = a.autoApproveEdits;
  if (a?.mayRequestTargets !== undefined) out.mayRequestTargets = a.mayRequestTargets;
  if (a?.notifyWhenNeedsMe !== undefined) out.notifyWhenNeedsMe = a.notifyWhenNeedsMe;
  const w = file.worktrees;
  if (w?.baseBranch !== undefined) out.baseBranch = w.baseBranch;
  if (w?.branchPrefix !== undefined) out.branchPrefix = w.branchPrefix;
  if (w?.location !== undefined) out.worktreeLocation = w.location;
  if (file.shell?.windows !== undefined) out.shellWindows = file.shell.windows;
  if (file.lineEndings !== undefined) out.lineEndings = file.lineEndings;
  if (file.dev?.url !== undefined) out.devUrl = file.dev.url;
  if (file.dev?.command !== undefined) out.devCommand = file.dev.command;
  if (file.env?.files !== undefined) out.envFiles = file.env.files;
  if (file.env?.shareWithAgents !== undefined) out.envShareWithAgents = file.env.shareWithAgents;
  return out;
};

/**
 * Effective settings = defaults ← app ← project file, each key tagged with where its value came from.
 * A `project` source drives the Settings reset affordance (reset deletes the key from the file).
 */
export const mergeSettings = (
  defaults: ProjectSettings,
  app: Partial<ProjectSettings>,
  projectFile: ProjectFileV1 | Partial<ProjectSettings> | null,
): EffectiveProjectSettings => {
  const fromFile: Partial<ProjectSettings> =
    projectFile === null ? {} : 'version' in projectFile ? projectSettingsFromFile(projectFile) : projectFile;
  const out: Partial<EffectiveProjectSettings> = {};
  for (const key of Object.keys(defaults) as (keyof ProjectSettings)[]) {
    let source: SettingsSource = 'default';
    let value: ProjectSettings[typeof key] = defaults[key];
    if (app[key] !== undefined) {
      source = 'app';
      value = app[key] as ProjectSettings[typeof key];
    }
    if (fromFile[key] !== undefined) {
      source = 'project';
      value = fromFile[key] as ProjectSettings[typeof key];
    }
    (out as Record<string, unknown>)[key] = { value, source };
  }
  return out as EffectiveProjectSettings;
};
