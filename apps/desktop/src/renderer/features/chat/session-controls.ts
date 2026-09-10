import {
  EFFORTS,
  MODEL_ALIASES,
  PERMISSION_MODES,
  copy,
  type Effort,
  type PermissionMode,
  type Session,
} from '@styx/core';

/**
 * Claude Code parity controls (owner addition, docs/handoff-discrepancies #54): option lists, value encoding
 * and visibility rules for the composer's session controls, the Spawn modal and Settings. Pure; no React.
 */

/** Select value that encodes `null` (the CLI's own default model / effort). */
export const DEFAULT_VALUE = 'default';

export interface ControlOption {
  value: string;
  label: string;
  /** Hover / AT description (permission-mode hints). */
  title?: string;
}

/** `short` = the composer line (360px: native selects size to their longest option, so labels stay terse). */
export const permissionModeOptions = (short = false): ControlOption[] =>
  PERMISSION_MODES.map((mode) => ({
    value: mode,
    label: short ? copy.chat.controls.modeShort[mode] : copy.session.permissionModes[mode],
    title: copy.session.permissionModeHints[mode],
  }));

/** `Default model` + the CLI aliases; a full model name already on the session is appended so the select stays truthful. */
export const modelOptions = (current: string | null, short = false): ControlOption[] => {
  const labels = short ? copy.chat.controls.modelShort : copy.session.models;
  const out: ControlOption[] = [
    { value: DEFAULT_VALUE, label: labels.default },
    ...MODEL_ALIASES.map((alias) => ({ value: alias, label: labels[alias] })),
  ];
  if (current !== null && current !== '' && !out.some((o) => o.value === current)) {
    out.push({ value: current, label: short ? shortModelLabel(current) : current });
  }
  return out;
};

/** `claude-fable-5-1` → "Fable" on the composer line (the CLI reports the full id at init); unknown ids stay as-is. */
export const shortModelLabel = (model: string): string => {
  const alias = MODEL_ALIASES.find((a) => model.toLowerCase().includes(a));
  return alias === undefined ? model : copy.chat.controls.modelShort[alias];
};

export const effortOptions = (): ControlOption[] => [
  { value: DEFAULT_VALUE, label: copy.session.efforts.default },
  ...EFFORTS.map((effort) => ({ value: effort, label: copy.session.efforts[effort] })),
];

export const encodeNullable = (value: string | null): string => value ?? DEFAULT_VALUE;

export const decodeModel = (value: string): string | null => (value === DEFAULT_VALUE ? null : value);

const isEffort = (value: string): value is Effort => (EFFORTS as readonly string[]).includes(value);
export const decodeEffort = (value: string): Effort | null => (isEffort(value) ? value : null);

const isPermissionMode = (value: string): value is PermissionMode =>
  (PERMISSION_MODES as readonly string[]).includes(value);
export const decodePermissionMode = (value: string): PermissionMode =>
  isPermissionMode(value) ? value : 'default';

/** Claude Code's own ⇧⇥ cycle: default → acceptEdits → plan → default. Any other mode returns to default. */
export const MODE_CYCLE: Readonly<Record<PermissionMode, PermissionMode>> = {
  default: 'acceptEdits',
  acceptEdits: 'plan',
  plan: 'default',
  bypassPermissions: 'default',
  dontAsk: 'default',
  auto: 'default',
};
export const nextPermissionMode = (mode: PermissionMode): PermissionMode => MODE_CYCLE[mode];

/** Which controls a session shows; all false → the composer keeps the prototype's static `Model ▾` hint. */
export interface SessionControls {
  /** Permission-mode select (Claude Code only). */
  mode: boolean;
  /** Model select (Claude Code and Cursor agent: the stream runners that accept `set_model`). */
  model: boolean;
  /** Effort select (Claude Code only; applies at the next relaunch). */
  effort: boolean;
  /** `Stop · esc` while a session is mid-turn. Every runner can be interrupted; the pty branch writes ^C. */
  stop: boolean;
  /** Hold the agent at its next tool boundary. Only the stream runner has a tool boundary to hold at. */
  pause: boolean;
  /** The session is already held: the control reads Resume. */
  paused: boolean;
}

const NO_CONTROLS: SessionControls = {
  mode: false,
  model: false,
  effort: false,
  stop: false,
  pause: false,
  paused: false,
};

/** A process is attached and the session has not ended: live settings can reach it. */
export const isLive = (session: Pick<Session, 'pid' | 'state'>): boolean =>
  session.pid !== null && session.state !== 'done';

export const sessionControls = (
  session: Pick<Session, 'agent' | 'runner' | 'pid' | 'state' | 'pausedReason'> | null | undefined,
): SessionControls => {
  if (session === null || session === undefined || !isLive(session)) return NO_CONTROLS;
  const claude = session.agent === 'claude';
  const streaming = session.runner === 'stream';
  const heldByUser = session.state === 'paused' && session.pausedReason === 'user';
  return {
    mode: claude,
    model: claude || session.agent === 'cursor',
    effort: claude,
    // Stop was gated on `streaming`, so codex / gemini / shell had no stop control at all even though the pty
    // branch has always written ^C. Every live runner mid-turn can be stopped.
    stop: session.state === 'working',
    // Pausing means parking a `can_use_tool` request, which only the stream runner produces.
    pause: streaming && (session.state === 'working' || heldByUser),
    paused: heldByUser,
  };
};

export const hasControls = (c: SessionControls): boolean =>
  c.mode || c.model || c.effort || c.stop || c.pause;

/** Which spawn-time selects an agent tile exposes (same rule as the live controls, minus the process gate). */
export const spawnControlsFor = (
  agent: Session['agent'],
): Pick<SessionControls, 'mode' | 'model' | 'effort'> => ({
  mode: agent === 'claude',
  model: agent === 'claude' || agent === 'cursor',
  effort: agent === 'claude',
});
