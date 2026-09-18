import { z } from 'zod';
import { projectIdSchema, targetIdSchema, timestampSchema } from './common';

/** Phase of a local dev-server run started from the design window. */
export const devRunPhaseSchema = z.enum(['starting', 'running', 'exited']);
export type DevRunPhase = z.infer<typeof devRunPhaseSchema>;

/**
 * What "Run locally" targets: a web dev server the design window loads, or a mobile app the design window mirrors
 * from the iOS Simulator / Android Emulator (owner request: the design tab as a simulator that shows the app as
 * it is being built).
 */
export const devPlatformSchema = z.enum(['web', 'ios', 'android']);
export type DevPlatform = z.infer<typeof devPlatformSchema>;
export const DEV_PLATFORMS: readonly DevPlatform[] = devPlatformSchema.options;
export const devicePlatformSchema = z.enum(['ios', 'android']);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;

/**
 * One "Run locally" process per project (owner addition: the design window used to need the URL typed in).
 * Main owns the pty; the renderer attaches a terminal by `terminalId`. `url` is the first localhost URL seen in
 * the output, which also fills the project's `devUrl` when it was empty.
 */
export const devRunSchema = z.object({
  projectId: projectIdSchema,
  runId: z.string().min(1),
  terminalId: z.string().min(1),
  command: z.string().min(1),
  /** `web` sniffs the server's URL into the design window; a device platform boots a simulator and mirrors it instead. */
  platform: devPlatformSchema.default('web'),
  phase: devRunPhaseSchema,
  url: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
});
export type DevRun = z.infer<typeof devRunSchema>;

/** A simulator / emulator Styx knows about on this machine (`device.list`). */
export const deviceSummarySchema = z.object({
  platform: devicePlatformSchema,
  /** iOS: the simulator UDID; Android: the AVD name (the serial once running). */
  id: z.string().min(1),
  /** `iPhone 17 Pro`, `Pixel 8` — what the project remembers (`devDevice`), since a UDID is per machine. */
  name: z.string().min(1),
  /** The runtime, when known: `iOS 26.5`, `Android 15`. */
  runtime: z.string().nullable(),
  state: z.enum(['shutdown', 'booting', 'booted']),
});
export type DeviceSummary = z.infer<typeof deviceSummarySchema>;

export const deviceSessionPhaseSchema = z.enum(['booting', 'ready', 'stopped', 'failed']);
/** How the device's screen reaches the design window: a live window capture, polled screenshots, or not at all (yet). */
export const deviceMirrorSchema = z.enum(['window', 'screenshots', 'none']);

/**
 * The simulator / emulator the design window mirrors for a project (one per project, main-owned, in memory like a
 * run). Boots on "Run locally" for a device platform, or from the device picker; outlives the run command
 * (Metro / `flutter run` may exit while the simulator keeps showing the app) and is stopped explicitly.
 */
export const deviceSessionSchema = z.object({
  projectId: projectIdSchema,
  platform: devicePlatformSchema,
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
  phase: deviceSessionPhaseSchema,
  mirror: deviceMirrorSchema,
  /** Whether taps and typing in the design window reach the device (adb, or idb on iOS when installed). */
  input: z.boolean(),
  /** Why `failed` / why the mirror is `none`, in words the pane can show. */
  error: z.string().nullable(),
  /** The device's screen size in pixels once known (screenshots are this size; taps are mapped to it). */
  screen: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable(),
  startedAt: timestampSchema,
});
export type DeviceSession = z.infer<typeof deviceSessionSchema>;

/** A pointer / key event the design window forwards to the mirrored device, in device screen pixels. */
export const deviceInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tap'), x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('swipe'),
    x1: z.number().int().nonnegative(),
    y1: z.number().int().nonnegative(),
    x2: z.number().int().nonnegative(),
    y2: z.number().int().nonnegative(),
    durationMs: z.number().int().positive().max(5000),
  }),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal('key'), key: z.enum(['enter', 'backspace', 'home', 'back', 'escape']) }),
]);
export type DeviceInput = z.infer<typeof deviceInputSchema>;

export const deployPhaseSchema = z.enum(['requesting-grant', 'running', 'succeeded', 'failed', 'cancelled']);
export type DeployPhase = z.infer<typeof deployPhaseSchema>;

/**
 * A deploy Styx is running (or just ran) for a target. Lives in the read model so progress survives closing the
 * modal: the status bar, the deploy button and a finish toast all read the same row.
 */
export const deploySchema = z.object({
  deployId: z.string().min(1),
  targetId: targetIdSchema,
  projectId: projectIdSchema,
  phase: deployPhaseSchema,
  terminalId: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
});
export type Deploy = z.infer<typeof deploySchema>;

export const isDeployActive = (d: Pick<Deploy, 'phase'>): boolean =>
  d.phase === 'requesting-grant' || d.phase === 'running';
