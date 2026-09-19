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
import {
  cliInstallSchema,
  ideInstallSchema,
  ideKindSchema,
  skillHostSchema,
  skillSummarySchema,
} from '../model/discovery';
import {
  deploySchema,
  devPlatformSchema,
  devRunSchema,
  deviceInputSchema,
  deviceMirrorSchema,
  devicePlatformSchema,
  deviceSessionSchema,
  deviceSummarySchema,
} from '../model/run';
import { checkpointSchema } from '../model/checkpoint';
import { agentLimitsSchema } from '../model/usage';
import { queuedMessageSchema } from '../model/session';
import { policyRuleSchema, policySchema } from '../model/policy';
import { targetNameSchema } from '../project-file';
import {
  askResolutionSchema,
  pausedReasonSchema,
  effortSchema,
  imageMediaTypeSchema,
  permissionModeSchema,
  sessionTogglesSchema,
  sessionPurposeSchema,
  transcriptMessageSchema,
} from '../model/session';
import { appSettingsSchema, previewDeviceSchema, projectSettingsSchema } from '../model/settings';
import { pendingAskSchema } from '../model/session';
import { notificationSchema } from '../model/notification';
import { projectSchema, repoSchema, worktreeSchema,
  worktreeConflictSchema,
} from '../model/project';
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
  /** `claude` / `codex`: a directory the CLI's own session history shows it has worked in (welcome wizard import). */
  source: z.enum(['scan', 'ide-recent', 'claude', 'codex']),
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
  runs: z.array(devRunSchema),
  devices: z.array(deviceSessionSchema),
  deploys: z.array(deploySchema),
  checkpoints: z.record(z.string(), z.array(checkpointSchema)),
  queues: z.record(z.string(), z.array(queuedMessageSchema)),
  limits: z.record(z.string(), agentLimitsSchema),
});
export type ReadModelSnapshot = z.infer<typeof readModelSnapshotSchema>;

const windowTarget = z.object({
  window: z.enum(['main', 'popout', 'dock']),
  sessionId: sessionIdSchema.optional(),
});

/**
 * Every mutation and query the renderer can make (plan §7). Outputs never contain secrets; credentials
 * go in via `target.connect.*` inputs and are consumed by main before anything is echoed back.
 */
export const commands = {
  // --- project ---
  /** `includeAgentHistory`: also the directories Claude Code and Codex have worked in (their own session history). */
  'project.scan': {
    input: z.object({
      includeIdeRecents: z.boolean().default(true),
      includeAgentHistory: z.boolean().default(true),
    }),
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
  /**
   * The design window: a live view of the running app beside the code. It is a native WebContentsView owned by
   * main, not an iframe (the renderer CSP is `default-src 'self'`) and not a `<webview>` (deprecated, and it
   * would run inside the renderer). The renderer reports where the hole in its layout is and main keeps the view
   * over it; `visible: false` detaches it so it cannot cover a modal, the palette, a sheet or a toast.
   */
  /**
   * Runs the provider's deploy command for a target. It requests a `deploy`-scoped grant first, so a prod deploy
   * hits the same MFA gate and audit trail as any other prod access — a deploy is not a privileged side door.
   */
  /**
   * Skills: what is installed, what the pinned catalogue offers, and the text of one so it can be read before
   * installing — a SKILL.md is instructions an agent will follow, so installing unread is the hazard.
   */
  'skills.list': {
    input: z.object({ projectId: projectIdSchema.nullable() }),
    output: z.object({ skills: z.array(skillSummarySchema) }),
  },
  'skills.catalogue': { input: z.object({}), output: z.object({ skills: z.array(skillSummarySchema) }) },
  'skills.preview': {
    input: z.object({ directory: z.string().min(1) }),
    output: z.object({ text: z.string() }),
  },
  /** Installs one catalogue skill for each chosen agent (its own skills dir); the shared `.agents` dir is never written. */
  'skills.install': {
    input: z.object({
      directory: z.string().min(1),
      scope: z.enum(['global', 'project']),
      hosts: z.array(skillHostSchema.exclude(['agents'])).min(1),
      projectId: projectIdSchema.nullable(),
    }),
    output: z.object({ skills: z.array(skillSummarySchema) }),
  },
  'skills.remove': {
    input: z.object({
      directory: z.string().min(1),
      scope: z.enum(['global', 'project']),
      host: skillHostSchema,
      projectId: projectIdSchema.nullable(),
    }),
    output: ok,
  },

  // --- agent connections (Settings › App › Agents; one connection per agent CLI, spawned per project) ---
  /**
   * Asks the CLI itself who it is signed in as (`claude auth status --json`, `codex login status`,
   * `cursor-agent status`; Gemini's account file) and stores the answer on the `cli_installs` row. Never a token.
   */
  'agent.verify': { input: z.object({ agent: agentSchema }), output: z.object({ cli: cliInstallSchema }) },
  /** Runs the CLI's own sign-in in a pty the renderer attaches to; `agent.login` events report running/exited. */
  'agent.login': {
    input: z.object({ agent: agentSchema }),
    output: z.object({ terminalId: z.string().min(1), command: z.string().min(1) }),
  },
  /** Opens the CLI's install documentation in the OS browser. */
  'agent.installGuide': { input: z.object({ agent: agentSchema }), output: ok },
  /**
   * Runs the vendor's own install command for a CLI that is not on the machine (core `installRecipes`, chosen by
   * platform and by which tools the login shell has) in a pty the renderer attaches to; `agent.install` events
   * report running/exited, and main re-detects and re-verifies the row when it exits. Owner addition (#98).
   */
  'agent.install': {
    input: z.object({ agent: agentSchema }),
    output: z.object({ terminalId: z.string().min(1), command: z.string().min(1) }),
  },

  // --- run locally (the design window's dev server) ---
  /**
   * Suggests run commands from the folder (`package.json` scripts and the lockfile, Makefile, manage.py, Cargo.toml,
   * go.mod). `worktreeId` is the lane the design window is looking at: the files there, committed or not, are what
   * runs (discrepancy #103); without it, the main checkout.
   */
  'run.detect': {
    input: z.object({ projectId: projectIdSchema, worktreeId: worktreeIdSchema.optional() }),
    output: z.object({
      suggestions: z.array(
        z.object({
          command: z.string().min(1),
          source: z.enum([
            'package.json',
            'makefile',
            'django',
            'cargo',
            'go',
            'expo',
            'react-native',
            'flutter',
            'xcode',
            'gradle',
          ]),
          /** What the suggestion runs on; absent = web. */
          platform: devPlatformSchema.optional(),
        }),
      ),
      /** Every platform the repo can run on, most likely first (`web` for a plain web app; `ios`/`android` for a mobile app). */
      platforms: z.array(devPlatformSchema),
    }),
  },
  /**
   * Starts (or restarts) the project's local run — in the lane it was asked from (`worktreeId`), else the main
   * checkout; the row lands in `model.runs`. With a device platform the simulator / emulator is booted first
   * (`model.devices`) and the design window mirrors it.
   */
  'run.start': {
    input: z.object({
      projectId: projectIdSchema,
      command: z.string().min(1),
      platform: devPlatformSchema.optional(),
      worktreeId: worktreeIdSchema.optional(),
    }),
    output: z.object({ runId: z.string().min(1), terminalId: z.string().min(1) }),
  },
  'run.stop': { input: z.object({ projectId: projectIdSchema }), output: ok },
  /** Clears a finished run from the model (the output strip closes). */
  'run.dismiss': { input: z.object({ projectId: projectIdSchema }), output: ok },
  'deploy.start': {
    input: z.object({ targetId: targetIdSchema }),
    output: z.object({ deployId: z.string(), terminalId: z.string() }),
  },
  /**
   * The user's own deploy command for a target that has no built-in verb (`gcloud run deploy …`); run through the
   * login shell with the grant's credential env. Null clears it. Stored on the target's config, machine-local.
   */
  'target.setDeployCommand': {
    input: z.object({ targetId: targetIdSchema, command: z.string().max(2000).nullable() }),
    output: ok,
  },
  'deploy.cancel': { input: z.object({ deployId: z.string() }), output: ok },
  /** What a target most likely deploys with, read from the repo (and Cloud Run's service list); pre-fills its command. */
  'deploy.detect': {
    input: z.object({ targetId: targetIdSchema }),
    output: z.object({ suggestions: z.array(z.object({ command: z.string().min(1), source: z.string() })) }),
  },
  'preview.set': {
    input: z.object({
      projectId: projectIdSchema,
      visible: z.boolean(),
      bounds: z.object({
        x: z.number().int(),
        y: z.number().int(),
        width: z.number().int().nonnegative(),
        height: z.number().int().nonnegative(),
      }),
      url: z.string(),
      device: previewDeviceSchema,
    }),
    output: ok,
  },
  'preview.reload': { input: z.object({}), output: ok },
  // --- device.* — the simulator / emulator the design window mirrors (owner request: a simulator in the design tab) ---
  /** Which tooling this machine has: Xcode's simctl, the Android SDK's adb / emulator, and input bridges (idb). */
  'device.tooling': {
    input: z.object({}),
    output: z.object({
      ios: z.boolean(),
      android: z.boolean(),
      /** Taps and typing can be forwarded: adb for Android; idb for iOS. */
      iosInput: z.boolean(),
      androidInput: z.boolean(),
      /** macOS Screen Recording permission for the live window mirror; `n/a` elsewhere. */
      screenAccess: z.enum(['granted', 'denied', 'not-determined', 'restricted', 'unknown', 'n/a']),
    }),
  },
  /** Simulators / emulators on this machine, booted ones first. */
  'device.list': {
    input: z.object({ platform: devicePlatformSchema.optional() }),
    output: z.object({ devices: z.array(deviceSummarySchema) }),
  },
  /**
   * Boots a simulator / emulator for the project (by name, else the project's remembered device, else the first
   * booted or available one) and starts mirroring it into the design window. The session lands in `model.devices`.
   */
  'device.boot': {
    input: z.object({
      projectId: projectIdSchema,
      platform: devicePlatformSchema,
      device: z.string().min(1).max(120).optional(),
    }),
    output: z.object({ deviceId: z.string().min(1), deviceName: z.string().min(1) }),
  },
  /** Stops mirroring and, when asked, shuts the simulator / emulator down; the row goes. */
  'device.stop': {
    input: z.object({ projectId: projectIdSchema, shutdown: z.boolean().default(false) }),
    output: ok,
  },
  /**
   * How the renderer should show the device: `window` arms a one-shot display-media request for the simulator's
   * window (the pane then calls `getDisplayMedia`); `screenshots` means frames arrive as `device.frame` events and
   * are read from `styx-device://frame/<projectId>?seq=n`; `none` with a reason otherwise.
   */
  'device.mirror': {
    input: z.object({ projectId: projectIdSchema }),
    output: z.object({ mode: deviceMirrorSchema, reason: z.string().nullable() }),
  },
  /** Forwards a tap / swipe / text / key to the mirrored device (adb; idb on iOS). Refused when input is unavailable. */
  'device.input': { input: z.object({ projectId: projectIdSchema, event: deviceInputSchema }), output: ok },
  /** Brings the simulator's own window to the front (interaction without an input bridge). */
  'device.focus': { input: z.object({ projectId: projectIdSchema }), output: ok },
  /** Opens the OS's Screen Recording privacy pane, where the live mirror gets its permission. */
  'device.openScreenAccess': { input: z.object({}), output: ok },
  /** Hands the current URL to the OS browser. */
  'preview.openExternal': { input: z.object({ url: z.string() }), output: ok },
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
      /** Set when Styx starts the session for a job of its own (Run locally / Deploy); gates `remember_command`. */
      purpose: sessionPurposeSchema.nullable().default(null),
      taskTargetId: targetIdSchema.optional(),
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
  /**
   * Messages held back while the agent is mid-turn (queue; Claude Code has no steer). `sendQueued` sends one now;
   * `unqueue` drops it (the renderer puts the text back into the composer).
   */
  'session.sendQueued': {
    input: z.object({ sessionId: sessionIdSchema, messageId: z.string().min(1) }),
    output: ok,
  },
  'session.unqueue': {
    input: z.object({ sessionId: sessionIdSchema, messageId: z.string().min(1) }),
    output: ok,
  },
  /** Turn checkpoints (hidden git refs): the turn's diff, and restoring the workspace to before the turn. */
  'checkpoint.diff': {
    input: z.object({ checkpointId: z.string().min(1) }),
    output: z.object({
      patch: z.string(),
      files: z.array(z.object({ path: z.string(), added: z.number().int(), removed: z.number().int() })),
    }),
  },
  'checkpoint.revert': { input: z.object({ checkpointId: z.string().min(1) }), output: ok },
  /** Re-reads every CLI's rate limits (Usage page refresh). */
  'usage.refreshLimits': { input: z.object({}), output: ok },
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
  /**
   * Brings a finished (not archived) session back (Done card → Reopen; owner addition #97): the row returns to `idle`
   * with its transcript, worktree and settings, and its CLI is relaunched with the earlier conversation resumed where
   * the runner can. Background tasks are run again from their button instead.
   */
  'session.reopen': { input: z.object({ sessionId: sessionIdSchema }), output: ok },
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
  /**
   * Keep lanes current (ADR-0023): merge the project's base branch into a lane. A conflict undoes the merge, marks
   * the lane and pauses its session; the agent that owns the lane must not be mid-turn.
   */
  'worktree.sync': {
    input: z.object({ worktreeId: worktreeIdSchema }),
    output: z.object({ merged: z.number().int().nonnegative(), conflict: worktreeConflictSchema.nullable() }),
  },
  /**
   * Styx finishes the merge (ADR-0025 phase B): the base is merged into the lane; its conflicts go to the lane's
   * own agent (or a hidden merge task when that agent is gone) as a Styx-authored turn with both sides' intent;
   * the result is checked, then committed. `started` is false when the lane was current, already resolving, or
   * the merge went through without conflicts (`merged` says how many commits came in).
   */
  'worktree.resolve': {
    input: z.object({ worktreeId: worktreeIdSchema }),
    output: z.object({ started: z.boolean(), merged: z.number().int().nonnegative() }),
  },
  /** Puts the lane back to before its last resolved merge (HEAD and the working tree), while nothing was committed on top. */
  'worktree.undoResolve': { input: z.object({ worktreeId: worktreeIdSchema }), output: ok },
  /**
   * Landing (ADR-0025 phase C): what the Land modal shows before anything happens — the files the lane changes
   * against the base (committed and not), and whether the base will be pushed afterwards (it has a remote).
   */
  'worktree.landPreview': {
    input: z.object({ worktreeId: worktreeIdSchema }),
    output: z.object({
      base: z.string(),
      files: z.array(z.object({ path: z.string(), added: z.number().int(), removed: z.number().int() })),
      willPush: z.boolean(),
      remote: z.string().nullable(),
    }),
  },
  /**
   * Land the lane: commit what is uncommitted, bring the base in (a conflict goes to the resolver first), run
   * the checks, merge the lane into the base with `message` as the record (`--no-ff`), push the base when it has
   * a remote, and keep the lane as "landed" with Undo. One landing at a time per project.
   */
  'worktree.land': {
    input: z.object({
      worktreeId: worktreeIdSchema,
      message: z.object({ title: z.string().min(1), body: z.string() }),
    }),
    output: z.object({ commit: z.string(), pushed: z.boolean(), steps: z.array(z.string()) }),
  },
  /** Takes a landing back out of the base (a revert of the landing commit, pushed again if the landing was) while it is the base's HEAD. */
  'worktree.undoLand': { input: z.object({ worktreeId: worktreeIdSchema }), output: ok },
  'worktree.diff': {
    input: z.object({ worktreeId: worktreeIdSchema, file: z.string().optional() }),
    output: z.object({ diff: z.string() }),
  },
  'worktree.openInIde': {
    input: z.object({ worktreeId: worktreeIdSchema, file: z.string().optional() }),
    output: ok,
  },
  /**
   * Commit, push and pull request in one step for a worktree (owner request after t3code): `generateMessage` asks
   * the project's default agent, headless, for a commit message or PR title + body from the diff; `publish` runs
   * the steps up to `through` (commit → push → pr), reusing what is already done (a clean tree skips the commit,
   * an existing PR is returned rather than duplicated). Push and `gh pr create` go through the GitHub shim, so the
   * grant flow applies as it would for an agent.
   */
  'worktree.generateMessage': {
    input: z.object({ worktreeId: worktreeIdSchema, kind: z.enum(['commit', 'pr']) }),
    output: z.object({ title: z.string(), body: z.string() }),
  },
  'worktree.publish': {
    input: z.object({
      worktreeId: worktreeIdSchema,
      through: z.enum(['commit', 'push', 'pr']),
      message: z.object({ title: z.string().min(1), body: z.string() }),
      draft: z.boolean().default(false),
    }),
    output: z.object({
      commit: z.string().nullable(),
      pushed: z.boolean(),
      pr: z.object({ number: z.number().int().positive(), url: z.string() }).nullable(),
      /** Commits merged in from the base branch before the push (ADR-0023); absent when nothing was behind. */
      synced: z.number().int().nonnegative().optional(),
    }),
  },

  // --- hunks ---
  // Agents already applied their edits to the worktree (owner decision, replaces spec §4.7 Accept/Reject): review
  // = look, revert, mark reviewed. There is no "accept"; nothing here stages or applies.
  /** Reverse-apply one pending hunk in the working tree (`git apply -R`), then rescan. */
  'hunk.revert': { input: z.object({ hunkId: hunkIdSchema }), output: ok },
  /** Revert every pending hunk of the session. */
  'hunk.revertAll': { input: z.object({ sessionId: sessionIdSchema }), output: ok },
  /** Mark every pending hunk reviewed (status `accepted`), except `.styx/project.json` (H-1); returns how many. */
  'hunk.done': {
    input: z.object({ sessionId: sessionIdSchema }),
    output: z.object({ reviewed: z.number().int().nonnegative() }),
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
  /**
   * "Locate binary" (spec §4.11 CLI-missing row): a hand-picked CLI path, probed and remembered across re-detects.
   * `path` may also be `~/…` or a bare command name (`claude`), resolved on the login shell's PATH (#98).
   */
  'detect.setBinary': {
    input: z.object({ agent: agentSchema, path: z.string().min(1) }),
    output: z.object({ cli: cliInstallSchema }),
  },
  /** Undo "Locate binary": forget the manual pick and re-detect, so a wrong file never traps the user. */
  'detect.clearBinary': {
    input: z.object({ agent: agentSchema }),
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
  /**
   * The agent dock: one narrow always-on-top window listing every agent that needs you, across every project.
   * `open: false` closes it, so a single palette action can toggle.
   */
  'window.agentDock': { input: z.object({ open: z.boolean() }), output: ok },
  /** Brings the main window forward on a session (the dock's cards route here). */
  'window.focusSession': { input: z.object({ sessionId: sessionIdSchema }), output: ok },
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
  /** A dock card was clicked: the main window brings that session forward. */
  'session.focus': z.object({ sessionId: sessionIdSchema }),
  /** Deploy lifecycle; the output itself streams over the pty channel like any other terminal. */
  'deploy.progress': z.object({
    deployId: z.string(),
    targetId: targetIdSchema,
    phase: z.enum(['requesting-grant', 'running', 'succeeded', 'failed', 'cancelled']),
    exitCode: z.number().int().nullable(),
    error: z.string().nullable(),
    terminalId: z.string().nullable(),
  }),
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
  /** A new frame of the mirrored device is readable at `styx-device://frame/<projectId>?seq=<seq>` (screenshots mode). */
  'device.frame': z.object({ projectId: projectIdSchema, seq: z.number().int().nonnegative() }),
  /** The design window's page: probed until the server answers, then loaded; `failed` after two minutes of silence. */
  'preview.status': z.object({
    url: z.string(),
    phase: z.enum(['waiting', 'loaded', 'failed']),
    attempts: z.number().int().nonnegative(),
  }),
  /** Progress of an `agent.login` terminal; main re-verifies the connection when it exits. */
  'agent.login': z.object({
    terminalId: z.string().min(1),
    agent: agentSchema,
    status: z.enum(['running', 'exited']),
    exitCode: z.number().int().nullable().optional(),
  }),
  /** Progress of an `agent.install` terminal; on exit main re-detects the CLIs and re-verifies the row first. */
  'agent.install': z.object({
    terminalId: z.string().min(1),
    agent: agentSchema,
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
  /** Stop returned the session's queued messages (oldest first): the renderer puts them back into the composer. */
  'queue.returned': z.object({ sessionId: sessionIdSchema, bodies: z.array(z.string().min(1)) }),
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
