import { z } from 'zod';
import { deltaSchema, effectiveProjectSettingsSchema } from '../deltas';
import { activityRowSchema } from '../model/activity';
import { auditEntrySchema } from '../model/audit';
import {
  agentSchema,
  askIdSchema,
  authMethodSchema,
  durationSchema,
  envSchema,
  grantIdSchema,
  hunkIdSchema,
  jsonObjectSchema,
  policyIdSchema,
  projectIdSchema,
  providerSchema,
  scopeSchema,
  sessionIdSchema,
  targetIdSchema,
  targetPolicySchema,
  worktreeIdSchema,
} from '../model/common';
import { cliInstallSchema, ideInstallSchema, ideKindSchema } from '../model/discovery';
import { policyRuleSchema, policySchema } from '../model/policy';
import { targetNameSchema } from '../project-file';
import {
  askResolutionSchema,
  pausedReasonSchema,
  effortSchema,
  imageMediaTypeSchema,
  permissionModeSchema,
  sessionTogglesSchema,
  transcriptMessageSchema,
} from '../model/session';
import { appSettingsSchema, projectSettingsSchema } from '../model/settings';
import { pendingAskSchema } from '../model/session';
import { notificationSchema } from '../model/notification';
import { projectSchema, repoSchema, worktreeSchema } from '../model/project';
import { sessionSchema } from '../model/session';
import { targetSchema } from '../model/target';
import { grantSchema } from '../model/grant';
import { agentChangeSchema } from '../model/hunk';

const ok = z.object({});
const idOut = <S extends z.ZodType>(key: string, schema: S) => z.object({ [key]: schema });

const projectSettingsPatch = projectSettingsSchema.partial();

/** sha256 (hex) of the canonical grant-policy summary of `.styx/project.json` (H-1 trust gate). */
export const policyHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const projectPolicySummarySchema = z.object({
  rules: z.array(
    z.object({
      id: z.string(),
      rule: policyRuleSchema,
      ruleText: z.string(),
      enabled: z.boolean().optional(),
    }),
  ),
  targets: z.array(
    z.object({ key: z.string(), policy: targetPolicySchema.nullable(), config: jsonObjectSchema }),
  ),
});
export type ProjectPolicySummary = z.infer<typeof projectPolicySummarySchema>;
export const projectPolicyDiffSchema = z.object({
  rules: z.object({ added: z.array(z.string()), removed: z.array(z.string()), changed: z.array(z.string()) }),
  targets: z.array(
    z.object({ target: z.string(), from: targetPolicySchema.nullable(), to: targetPolicySchema.nullable() }),
  ),
  configChanged: z.array(z.string()),
});
export type ProjectPolicyDiff = z.infer<typeof projectPolicyDiffSchema>;
const projectSettingsKey = z.enum(
  Object.keys(projectSettingsSchema.shape) as [
    keyof typeof projectSettingsSchema.shape,
    ...(keyof typeof projectSettingsSchema.shape)[],
  ],
);

const scannedRepoSchema = z.object({
  path: z.string(),
  remote: z.string().nullable(),
  branch: z.string().nullable(),
  /** False for a plain folder (IDE recents list those too); it is added as-is, meta reads `no git`. */
  hasGit: z.boolean(),
  source: z.enum(['scan', 'ide-recent']),
  lastModifiedAt: z.number().int().nullable(),
  /** Unchecked by default when no remote and stale (spec §4.9). */
  suggested: z.boolean(),
});

const readModelSnapshotSchema = z.object({
  seq: z.number().int().nonnegative(),
  projects: z.array(projectSchema),
  repos: z.array(repoSchema),
  worktrees: z.array(worktreeSchema),
  sessions: z.array(sessionSchema),
  targets: z.array(targetSchema),
  grants: z.array(grantSchema),
  auditEntries: z.array(auditEntrySchema),
  policies: z.array(policySchema),
  pendingAsks: z.array(pendingAskSchema),
  notifications: z.array(notificationSchema),
  transcripts: z.record(z.string(), z.array(transcriptMessageSchema)),
  hunks: z.record(z.string(), z.array(agentChangeSchema)),
  discovery: z.object({ ides: z.array(ideInstallSchema), clis: z.array(cliInstallSchema) }),
  settings: z.object({
    app: appSettingsSchema,
    project: z.record(z.string(), effectiveProjectSettingsSchema),
  }),
  /** Per-machine persisted UI state (README: ui.screen / projectId / window positions). */
  ui: z.object({
    screen: z.string().nullable(),
    projectId: projectIdSchema.nullable(),
    projectSession: z.record(z.string(), sessionIdSchema),
    paneSizes: z.record(z.string(), z.number()),
  }),
  popouts: z.array(sessionIdSchema),
  activity: z.array(activityRowSchema),
});
export type ReadModelSnapshot = z.infer<typeof readModelSnapshotSchema>;

const windowTarget = z.object({ window: z.enum(['main', 'popout']), sessionId: sessionIdSchema.optional() });

/**
 * Every mutation and query the renderer can make (plan §7). Outputs never contain secrets; credentials
 * go in via `target.connect.*` inputs and are consumed by main before anything is echoed back.
 */
export const commands = {
  // --- project ---
  'project.scan': {
    input: z.object({ includeIdeRecents: z.boolean().default(true) }),
    output: z.object({ repos: z.array(scannedRepoSchema) }),
  },
  /** Any readable directory; a folder without `.git` becomes a plain-folder project (`Repo.defaultBranch: null`). */
  'project.add': {
    input: z.object({ path: z.string().min(1), name: z.string().min(1).optional() }),
    output: idOut('projectId', projectIdSchema),
  },
  /** `git init -b main` (+ an empty first commit) in a plain-folder project; the main worktree lands on `main`. */
  'project.gitInit': { input: z.object({ projectId: projectIdSchema }), output: ok },
  /** `into` is the full destination folder (`~/code/<repo>`); progress arrives as `project.cloneProgress`. */
  'project.clone': {
    input: z.object({
      url: z.string().min(1),
      into: z.string().min(1),
      openInIde: z.boolean().default(false),
    }),
    output: idOut('projectId', projectIdSchema),
  },
  'project.create': {
    input: z.object({
      name: z.string().min(1),
      location: z.string().min(1),
      startFrom: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('empty') }),
        z.object({ kind: z.literal('template'), template: z.string().min(1) }),
        z.object({ kind: z.literal('agent'), agent: agentSchema, brief: z.string().min(1) }),
      ]),
      gitInit: z.boolean(),
      createGithubRepo: z.boolean(),
      copyTargetsFrom: projectIdSchema.nullable(),
      openInIde: z.boolean(),
    }),
    output: z.object({ projectId: projectIdSchema, sessionId: sessionIdSchema.nullable() }),
  },
  'project.remove': {
    input: z.object({ projectId: projectIdSchema, deleteFiles: z.boolean().default(false) }),
    output: ok,
  },
  'project.reorder': { input: z.object({ projectIds: z.array(projectIdSchema) }), output: ok },
  'project.select': { input: z.object({ projectId: projectIdSchema }), output: ok },
  'project.settings.set': {
    input: z.object({ projectId: projectIdSchema, patch: projectSettingsPatch }),
    output: ok,
  },
  /**
   * Trust gate for repo-authored grant policy (`policies.extra`, `targets[].policy`): records the file's current policy
   * hash as accepted for this machine, applies it, clears the `project-policy:<projectId>` banner and audits the diff.
   */
  'project.policy.accept': {
    input: z.object({ projectId: projectIdSchema, hash: policyHashSchema }),
    output: ok,
  },
  /** What the file currently asks for, its hash (pass it to `project.policy.accept`) and the diff against the accepted set. */
  'project.policy.pending': {
    input: z.object({ projectId: projectIdSchema }),
    output: z.object({
      hash: policyHashSchema,
      accepted: z.boolean(),
      summary: projectPolicySummarySchema,
      diff: projectPolicyDiffSchema,
    }),
  },
  'project.settings.reset': {
    input: z.object({ projectId: projectIdSchema, key: projectSettingsKey }),
    output: ok,
  },
  /** Template tile (spec §4.12): built-ins from `resources/templates` plus repos tagged `styx-template` in the GitHub org. */
  'project.templates': {
    input: z.object({}),
    output: z.object({
      builtins: z.array(z.string().min(1)),
      org: z.array(z.object({ name: z.string().min(1), fullName: z.string().min(1) })),
    }),
  },

  // --- native dialogs (main-owned; the renderer never touches the filesystem) ---
  /** OS folder picker parented to the main window; `null` when dismissed. `STYX_E2E` answers with `STYX_E2E_PICK`. */
  'dialog.pickFolder': {
    input: z.object({ title: z.string().min(1).optional(), defaultPath: z.string().min(1).optional() }),
    output: z.object({ path: z.string().nullable() }),
  },
  'dialog.pickFile': {
    input: z.object({
      title: z.string().min(1).optional(),
      defaultPath: z.string().min(1).optional(),
      filters: z
        .array(z.object({ name: z.string().min(1), extensions: z.array(z.string().min(1)) }))
        .optional(),
    }),
    output: z.object({ path: z.string().nullable() }),
  },

  // --- session ---
  'session.spawn': {
    input: z.object({
      projectId: projectIdSchema,
      agent: agentSchema,
      worktree: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('new'), base: z.string().min(1), branch: z.string().min(1) }),
        z.object({ kind: z.literal('existing'), worktreeId: worktreeIdSchema }),
      ]),
      firstMessage: z.string(),
      toggles: sessionTogglesSchema,
      model: z.string().nullable().default(null),
      permissionMode: permissionModeSchema.default('default'),
      effort: effortSchema.nullable().default(null),
    }),
    output: z.object({ sessionId: sessionIdSchema, worktreeId: worktreeIdSchema }),
  },
  /**
   * Live session settings (Claude Code parity): model and permission mode switch immediately over the stream
   * (`set_model` / `set_permission_mode`); effort applies at the next (re)launch. Stored on the session.
   */
  'session.configure': {
    input: z.object({
      sessionId: sessionIdSchema,
      model: z.string().nullable().optional(),
      permissionMode: permissionModeSchema.optional(),
      effort: effortSchema.nullable().optional(),
    }),
    output: ok,
  },
  /** Stops the current turn without ending the session (stream `interrupt`; Ctrl+C on a pty). */
  'session.interrupt': { input: z.object({ sessionId: sessionIdSchema }), output: ok },
  'session.sendMessage': {
    input: z.object({
      sessionId: sessionIdSchema,
      body: z.string(),
      /** Images go to the CLI as base64 image blocks; files are read by main (inside the worktree) and inlined. */
      attachments: z
        .array(
          z.discriminatedUnion('kind', [
            z.object({
              kind: z.literal('image'),
              name: z.string().min(1),
              mediaType: imageMediaTypeSchema,
              /** base64 without a data: prefix. */
              data: z.string().min(1),
            }),
            z.object({ kind: z.literal('file'), path: z.string().min(1) }),
          ]),
        )
        .max(20)
        .default([]),
    }),
    output: ok,
  },
  'session.ptyInput': { input: z.object({ sessionId: sessionIdSchema, data: z.string() }), output: ok },
  'session.ptyResize': {
    input: z.object({
      sessionId: sessionIdSchema,
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }),
    output: ok,
  },
  'session.stop': { input: z.object({ sessionId: sessionIdSchema }), output: ok },
  'session.archive': { input: z.object({ sessionId: sessionIdSchema }), output: ok },
  /** Close chat: ends the session if it is running and archives it, whatever state it was in. */
  'session.close': { input: z.object({ sessionId: sessionIdSchema }), output: ok },
  /**
   * Hold the agent from the chat: it stops at its next tool boundary and nothing is discarded, so `session.resume`
   * continues the same run. Distinct from `session.interrupt`, which ends the current turn.
   */
  'session.pause': { input: z.object({ sessionId: sessionIdSchema }), output: ok },
  'session.resume': { input: z.object({ sessionId: sessionIdSchema }), output: ok },

  // --- asks & grants ---
  'ask.respond': { input: z.object({ askId: askIdSchema, resolution: askResolutionSchema }), output: ok },
  'grant.approve': {
    input: z.object({
      grantId: grantIdSchema,
      duration: durationSchema,
      scope: z.array(scopeSchema).min(1).optional(),
    }),
    output: z.object({ grantId: grantIdSchema, expiresAt: z.number().int().nullable() }),
  },
  'grant.deny': { input: z.object({ grantId: grantIdSchema }), output: ok },
  'grant.revoke': {
    input: z.object({ grantId: grantIdSchema, triggeredBy: z.string().default('lock glyph') }),
    output: ok,
  },

  // --- targets ---
  'target.connect.start': {
    input: z.object({
      projectId: projectIdSchema,
      provider: providerSchema,
      env: envSchema,
      name: targetNameSchema.optional(),
    }),
    output: z.object({ flowId: z.string(), authMethod: authMethodSchema, browserUrl: z.string().nullable() }),
  },
  'target.connect.saveKey': {
    input: z.object({
      projectId: projectIdSchema,
      provider: z.enum(['aws', 'gcp']),
      name: targetNameSchema,
      env: envSchema,
      accessKey: z.string().min(1),
      secret: z.string().min(1),
      config: jsonObjectSchema.default({}),
    }),
    output: idOut('targetId', targetIdSchema),
  },
  'target.connect.saveToken': {
    /** Pasted token for Vercel / Supabase / GitHub PAT flows started by target.connect.start. */
    input: z.object({ targetId: targetIdSchema, token: z.string().min(1) }),
    output: idOut('targetId', targetIdSchema),
  },
  'target.connect.saveSsh': {
    input: z.object({
      projectId: projectIdSchema,
      name: targetNameSchema,
      env: envSchema,
      host: z.string().min(1),
      user: z.string().min(1),
      keyPath: z.string().min(1),
      /** Non-standard SSH ports are common on jump/bastion hosts; 22 when omitted. */
      port: z.number().int().min(1).max(65535).default(22),
      /** Passphrase for an encrypted key. The vault and the agent already support it; the form did not collect it. */
      passphrase: z.string().optional(),
    }),
    output: idOut('targetId', targetIdSchema),
  },
  /**
   * "Connect with the provider's CLI" (primary path): what the local `gcloud` / `aws` / `gh` / `vercel` / `supabase`
   * already knows. Accounts are identities only (emails, profile names, logins); tokens never cross IPC.
   */
  'target.connect.cliStatus': {
    input: z.object({ provider: providerSchema }),
    output: z.object({
      installed: z.boolean(),
      binary: z.string().nullable(),
      version: z.string().nullable(),
      loginCommand: z.string(),
      accounts: z.array(
        z.object({ id: z.string(), label: z.string(), active: z.boolean(), detail: z.string().optional() }),
      ),
    }),
  },
  /** Runs the CLI's own login flow in a terminal the renderer attaches to over the `pty` channel; `connect.cliLogin` reports exit. */
  'target.connect.cliLogin': {
    input: z.object({ projectId: projectIdSchema, provider: providerSchema, account: z.string().optional() }),
    output: z.object({ terminalId: z.string() }),
  },
  /** Saves a target bound to a CLI account (`authMethod: 'cli'`); the vault entry names the account, never a secret. */
  'target.connect.cliSave': {
    input: z.object({
      projectId: projectIdSchema,
      provider: providerSchema,
      env: envSchema,
      name: targetNameSchema,
      account: z.string().min(1),
      config: jsonObjectSchema.default({}),
    }),
    output: idOut('targetId', targetIdSchema),
  },
  'target.test': {
    input: z.object({ targetId: targetIdSchema }),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  },
  /** Runs the health check now (one target, or every connected target when omitted). */
  'target.refresh': {
    input: z.object({ targetId: targetIdSchema.optional() }),
    output: z.object({ ok: z.boolean() }),
  },
  'target.setPolicy': {
    input: z.object({ targetId: targetIdSchema, policy: targetPolicySchema }),
    output: ok,
  },
  'target.remove': { input: z.object({ targetId: targetIdSchema }), output: ok },
  'target.reconnect': {
    input: z.object({ targetId: targetIdSchema }),
    output: z.object({ flowId: z.string(), authMethod: authMethodSchema }),
  },

  // --- policies ---
  'policy.upsert': {
    input: z.object({
      policyId: policyIdSchema.nullable(),
      rule: policyRuleSchema,
      ruleText: z.string().min(1),
      enabled: z.boolean().default(true),
    }),
    output: idOut('policyId', policyIdSchema),
  },
  'policy.toggle': { input: z.object({ policyId: policyIdSchema, enabled: z.boolean() }), output: ok },
  'policy.reorder': { input: z.object({ policyIds: z.array(policyIdSchema) }), output: ok },
  'policy.remove': { input: z.object({ policyId: policyIdSchema }), output: ok },
  'policy.export': { input: z.object({}), output: z.object({ json: z.string() }) },

  // --- worktrees ---
  'worktree.create': {
    input: z.object({ projectId: projectIdSchema, branch: z.string().min(1), base: z.string().min(1) }),
    output: idOut('worktreeId', worktreeIdSchema),
  },
  'worktree.archive': { input: z.object({ worktreeId: worktreeIdSchema }), output: ok },
  'worktree.fetch': {
    input: z.object({ projectId: projectIdSchema }),
    output: z.object({ ahead: z.number().int(), behind: z.number().int() }),
  },
  'worktree.diff': {
    input: z.object({ worktreeId: worktreeIdSchema, file: z.string().optional() }),
    output: z.object({ diff: z.string() }),
  },
  'worktree.openInIde': {
    input: z.object({ worktreeId: worktreeIdSchema, file: z.string().optional() }),
    output: ok,
  },

  // --- hunks ---
  'hunk.accept': { input: z.object({ hunkId: hunkIdSchema }), output: ok },
  'hunk.reject': { input: z.object({ hunkId: hunkIdSchema }), output: ok },
  'hunk.acceptAll': { input: z.object({ sessionId: sessionIdSchema }), output: ok },
  'hunk.rejectAll': { input: z.object({ sessionId: sessionIdSchema }), output: ok },
  'hunk.done': {
    input: z.object({ sessionId: sessionIdSchema }),
    output: z.object({ applied: z.number().int().nonnegative() }),
  },

  // --- fs (confined to the worktree path) ---
  'fs.readFile': {
    input: z.object({ worktreeId: worktreeIdSchema, path: z.string().min(1) }),
    output: z.object({ text: z.string(), eol: z.enum(['lf', 'crlf']) }),
  },
  'fs.writeFile': {
    input: z.object({ worktreeId: worktreeIdSchema, path: z.string().min(1), text: z.string() }),
    output: ok,
  },
  /** Fuzzy file search inside a worktree for the composer's `@` picker (tracked + untracked, ignores honoured). */
  'fs.find': {
    input: z.object({
      worktreeId: worktreeIdSchema,
      query: z.string().default(''),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    output: z.object({ paths: z.array(z.string()), truncated: z.boolean() }),
  },
  /** Opens an https link from a transcript in the default browser (main validates the scheme). */
  'link.open': { input: z.object({ url: z.string().url() }), output: ok },
  'fs.listDir': {
    input: z.object({ worktreeId: worktreeIdSchema, path: z.string().default('') }),
    output: z.object({
      entries: z.array(
        z.object({
          name: z.string(),
          kind: z.enum(['file', 'dir']),
          gitStatus: z.enum(['M', 'A', 'D', '?']).nullable(),
        }),
      ),
    }),
  },

  // --- terminal (user terminals, not agent ptys) ---
  'terminal.spawn': {
    input: z.object({ worktreeId: worktreeIdSchema }),
    output: z.object({ terminalId: z.string() }),
  },
  'terminal.input': { input: z.object({ terminalId: z.string(), data: z.string() }), output: ok },
  'terminal.resize': {
    input: z.object({
      terminalId: z.string(),
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }),
    output: ok,
  },
  'terminal.kill': { input: z.object({ terminalId: z.string() }), output: ok },

  // --- audit ---
  'audit.list': {
    input: z.object({
      cursor: z.number().int().nullable().default(null),
      limit: z.number().int().positive().max(500).default(100),
      targetId: targetIdSchema.optional(),
      sessionId: sessionIdSchema.optional(),
    }),
    output: z.object({ entries: z.array(auditEntrySchema), nextCursor: z.number().int().nullable() }),
  },
  'audit.export': { input: z.object({}), output: z.object({ json: z.string() }) },
  'audit.verifyChain': {
    input: z.object({}),
    output: z.object({ ok: z.boolean(), brokenAtSeq: z.number().int().nullable() }),
  },

  // --- settings ---
  'settings.get': { input: z.object({}), output: z.object({ app: appSettingsSchema }) },
  'settings.set': { input: z.object({ patch: appSettingsSchema.partial() }), output: ok },

  // --- detection & IDE ---
  'detect.ides': { input: z.object({}), output: z.object({ ides: z.array(ideInstallSchema) }) },
  'detect.clis': { input: z.object({}), output: z.object({ clis: z.array(cliInstallSchema) }) },
  /** "Locate binary" (spec §4.11 CLI-missing row): a hand-picked CLI path, probed and remembered across re-detects. */
  'detect.setBinary': {
    input: z.object({ agent: agentSchema, path: z.string().min(1) }),
    output: z.object({ cli: cliInstallSchema }),
  },
  'ide.import': {
    input: z.object({
      ideId: z.string().min(1),
      keybindings: z.boolean(),
      theme: z.boolean(),
      recents: z.boolean(),
    }),
    output: z.object({
      recents: z.array(scannedRepoSchema),
      keybindingsImported: z.number().int().nonnegative(),
      themeImported: z.boolean(),
    }),
  },
  'ide.installOpenIn': { input: z.object({}), output: ok },
  'ide.setFallback': { input: z.object({ kind: ideKindSchema.nullable() }), output: ok },

  // --- windows & notifications ---
  'window.popout': { input: z.object({ sessionId: sessionIdSchema }), output: ok },
  'window.dock': { input: z.object({ sessionId: sessionIdSchema }), output: ok },
  'window.control': {
    input: windowTarget.extend({ action: z.enum(['minimize', 'maximize', 'restore', 'close']) }),
    output: ok,
  },
  'notify.setDnd': { input: z.object({ dnd: z.boolean() }), output: ok },
  'notify.later': { input: z.object({ notificationId: z.string().min(1) }), output: ok },

  // --- misc ---
  'onboarding.complete': { input: z.object({}), output: ok },
  'ui.persist': {
    input: z.object({
      screen: z.string().optional(),
      projectId: projectIdSchema.nullable().optional(),
      projectSession: z.record(z.string(), sessionIdSchema).optional(),
      paneSizes: z.record(z.string(), z.number()).optional(),
    }),
    output: ok,
  },
  'store.snapshot': { input: z.object({}), output: readModelSnapshotSchema },
} as const;

export type Commands = typeof commands;
export type CommandName = keyof Commands;
export type CommandInput<N extends CommandName> = z.input<Commands[N]['input']>;
export type CommandParsedInput<N extends CommandName> = z.output<Commands[N]['input']>;
export type CommandOutput<N extends CommandName> = z.output<Commands[N]['output']>;

export const COMMAND_NAMES = Object.keys(commands) as CommandName[];
export const isCommandName = (name: string): name is CommandName => Object.hasOwn(commands, name);

export const commandErrorSchema = z.object({
  code: z.enum([
    'invalid-input',
    'not-found',
    'invalid-transition',
    'mfa-failed',
    'mfa-required',
    'provider-error',
    'cli-missing',
    'git-error',
    'fs-denied',
    'forbidden',
    'internal',
  ]),
  message: z.string(),
  detail: jsonObjectSchema.optional(),
});
export type CommandError = z.infer<typeof commandErrorSchema>;

export type CommandResult<N extends CommandName = CommandName> =
  { ok: true; value: CommandOutput<N> } | { ok: false; error: CommandError };

export const commandResultSchema = <N extends CommandName>(name: N) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: commands[name].output }),
    z.object({ ok: z.literal(false), error: commandErrorSchema }),
  ]);

// --- Events (main → renderer) ---------------------------------------------

export const events = {
  'store.delta': z.object({ seq: z.number().int().nonnegative(), deltas: z.array(deltaSchema) }),
  /** Separate channel (`styx:pty`), ≤16 ms batches, flow-control ack. */
  'pty.data': z.object({ id: z.string().min(1), data: z.string(), seq: z.number().int().nonnegative() }),
  'pty.exit': z.object({ id: z.string().min(1), exitCode: z.number().int().nullable() }),
  'ask.opened': z.object({ askId: askIdSchema, sessionId: sessionIdSchema, projectId: projectIdSchema }),
  'grant.result': z.object({
    grantId: grantIdSchema,
    sessionId: sessionIdSchema.nullable(),
    outcome: z.enum(['granted', 'denied', 'revoked', 'expired']),
  }),
  'connect.progress': z.object({
    flowId: z.string(),
    phase: z.enum(['waiting-browser', 'exchanging', 'testing', 'saved', 'failed']),
    message: z.string().nullable(),
  }),
  /** Progress of a `target.connect.cliLogin` terminal: emitted `running` on spawn and `exited` when the CLI returns. */
  'connect.cliLogin': z.object({
    terminalId: z.string().min(1),
    provider: providerSchema,
    status: z.enum(['running', 'exited']),
    exitCode: z.number().int().nullable().optional(),
  }),
  /** `project.clone` progress: `cloning` on start, then `done` (with the project id) or `error`. */
  'project.cloneProgress': z.object({
    url: z.string(),
    dest: z.string(),
    phase: z.enum(['cloning', 'done', 'error']),
    message: z.string().nullable(),
    projectId: projectIdSchema.nullable(),
  }),
  'banner.set': z.object({
    bannerKey: z.string().min(1),
    kind: z.enum(['auth-expired', 'cli-missing', 'cli-outdated', 'conflict', 'project-policy']),
    text: z.string(),
    cta: z.string(),
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('reconnect'), targetId: targetIdSchema }),
      z.object({ kind: z.literal('install-guide'), agent: agentSchema }),
      z.object({ kind: z.literal('resolve'), worktreeId: worktreeIdSchema }),
      /** `.styx/project.json` wants to change grant policies: review in Settings › Project targets (H-1 trust gate). */
      z.object({
        kind: z.literal('review-project-policy'),
        projectId: projectIdSchema,
        hash: policyHashSchema,
      }),
    ]),
    sessionId: sessionIdSchema.nullable(),
    reason: pausedReasonSchema.nullable(),
  }),
  'banner.clear': z.object({ bannerKey: z.string().min(1) }),
  'hunks.changed': z.object({
    sessionId: sessionIdSchema,
    worktreeId: worktreeIdSchema,
    pending: z.number().int().nonnegative(),
  }),
  'theme.resolved': z.object({ theme: z.enum(['dark', 'light']) }),
  /** OS-side navigation (tray left-click / dock menu → Agents board, spec §4.14). The renderer switches screen. */
  'nav.go': z.object({ screen: z.enum(['home', 'workspace', 'agents', 'repo', 'approvals', 'settings']) }),
} as const;

export type Events = typeof events;
export type EventName = keyof Events;
export type EventPayload<N extends EventName> = z.output<Events[N]>;

export const EVENT_NAMES = Object.keys(events) as EventName[];
export const isEventName = (name: string): name is EventName => Object.hasOwn(events, name);

/** The three IPC channel names (rules/ipc.md); nothing else is registered. */
export const CHANNELS = { command: 'styx:cmd', store: 'styx:store', pty: 'styx:pty' } as const;
