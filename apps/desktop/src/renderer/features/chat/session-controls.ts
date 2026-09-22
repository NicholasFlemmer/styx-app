import {
  EFFORTS,
  MODEL_ALIASES,
  PERMISSION_MODES,
  copy,
  type Agent,
  type Effort,
  type ModelInfo,
  type PermissionMode,
  type Session,
} from '@styx/core';

/**
 * Session controls (owner addition, docs/handoff-discrepancies #54 and #83): option lists, value encoding and
 * visibility rules for the composer's selects, the Spawn modal and Settings. Agent-aware since #83: Claude keeps
 * its static aliases and levels; a CLI that publishes a catalogue (Codex `model/list`) drives the model list and
 * the per-model effort list from it; Gemini and Cursor offer the CLI default plus whatever the session already
 * carries. Pure; no React.
 */

/** Select value that encodes `null` (the CLI's own default model / effort). */
export const DEFAULT_VALUE = 'default';

export interface ControlOption {
  value: string;
  label: string;
  /** Hover / AT description (permission-mode hints). */
  title?: string;
}

/** Claude Code's `--effort` levels; `ultra` exists only on the Codex models whose catalogue row lists it. */
export const STANDARD_EFFORTS: readonly Effort[] = EFFORTS.filter((e) => e !== 'ultra');

/**
 * Agents whose runner applies an effort: Claude (`--effort`, at the next launch) and Codex
 * (`model_reasoning_effort`, per turn). ACP (Gemini, Cursor) has no effort setting, so none is offered.
 */
export const takesEffort = (agent: Agent): boolean => agent === 'claude' || agent === 'codex';

type HintedAgent = keyof typeof copy.session.permissionModeHintsByAgent;
const hasAgentHints = (agent: Agent): agent is HintedAgent =>
  Object.hasOwn(copy.session.permissionModeHintsByAgent, agent);

/** What a Styx permission mode does for this agent (Claude's own wording, or the per-agent mapping of §5–§6). */
export const permissionModeHint = (agent: Agent, mode: PermissionMode): string =>
  hasAgentHints(agent)
    ? copy.session.permissionModeHintsByAgent[agent][mode]
    : copy.session.permissionModeHints[mode];

/** `short` = the composer line (360px: native selects size to their longest option, so labels stay terse). */
export const permissionModeOptionsFor = (agent: Agent, short = false): ControlOption[] =>
  PERMISSION_MODES.map((mode) => ({
    value: mode,
    label: short ? copy.chat.controls.modeShort[mode] : copy.session.permissionModes[mode],
    title: permissionModeHint(agent, mode),
  }));

export const permissionModeOptions = (short = false): ControlOption[] =>
  permissionModeOptionsFor('claude', short);

/** Catalogue rows for a select: the CLI's default first, then the rest as published; hidden rows only when current. */
const visibleCatalogue = (catalogue: readonly ModelInfo[], current: string | null): ModelInfo[] => {
  const shown = catalogue.filter((m) => !m.hidden || m.id === current);
  return [...shown.filter((m) => m.isDefault), ...shown.filter((m) => !m.isDefault)];
};

/**
 * `Default model`, then the catalogue when the CLI publishes one (label = its label), else Claude's aliases for
 * Claude, else nothing; a model already on the session that is in neither list is appended so the select stays
 * truthful.
 */
export const modelOptionsFor = (
  agent: Agent,
  current: string | null,
  catalogue: readonly ModelInfo[],
  short = false,
): ControlOption[] => {
  const labels = short ? copy.chat.controls.modelShort : copy.session.models;
  const out: ControlOption[] = [{ value: DEFAULT_VALUE, label: labels.default }];
  if (catalogue.length > 0) {
    out.push(...visibleCatalogue(catalogue, current).map((m) => ({ value: m.id, label: m.label })));
  } else if (agent === 'claude') {
    out.push(...MODEL_ALIASES.map((alias) => ({ value: alias, label: labels[alias] })));
  }
  if (current !== null && current !== '' && !out.some((o) => o.value === current)) {
    out.push({ value: current, label: short ? shortModelLabel(current, catalogue) : current });
  }
  return out;
};

/** Claude-shaped list (`Default model` + aliases); kept for callers that predate the catalogue. */
export const modelOptions = (current: string | null, short = false): ControlOption[] =>
  modelOptionsFor('claude', current, [], short);

/**
 * `gpt-6-astra` → "GPT-6 Astra" from the catalogue, `claude-fable-5-1` → "Fable" from the aliases (the CLI
 * reports the full id at init); unknown ids stay as-is.
 */
export const shortModelLabel = (model: string, catalogue: readonly ModelInfo[] = []): string => {
  const row = catalogue.find((m) => m.id === model);
  if (row !== undefined) return row.label;
  const alias = MODEL_ALIASES.find((a) => model.toLowerCase().includes(a));
  return alias === undefined ? model : copy.chat.controls.modelShort[alias];
};

/** The catalogue row the effort list follows: the chosen model, else the CLI's default, else the first row. */
const effortSourceOf = (model: string | null, catalogue: readonly ModelInfo[]): ModelInfo | undefined =>
  (model === null ? undefined : catalogue.find((m) => m.id === model)) ??
  catalogue.find((m) => m.isDefault) ??
  catalogue[0];

/** The effort levels this agent takes for `model`: the catalogue row's own list, else the standard five; [] when none. */
export const effortLevelsFor = (
  agent: Agent,
  model: string | null,
  catalogue: readonly ModelInfo[],
): readonly Effort[] => {
  if (!takesEffort(agent)) return [];
  const source = effortSourceOf(model, catalogue);
  return source === undefined ? STANDARD_EFFORTS : source.efforts;
};

/** `Default effort` first, then `effortLevelsFor`; an effort already set that the model lacks is appended. */
export const effortOptionsFor = (
  agent: Agent,
  model: string | null,
  catalogue: readonly ModelInfo[],
  current: Effort | null = null,
): ControlOption[] => {
  const out: ControlOption[] = [
    { value: DEFAULT_VALUE, label: copy.session.efforts.default },
    ...effortLevelsFor(agent, model, catalogue).map((effort) => ({
      value: effort,
      label: copy.session.efforts[effort],
    })),
  ];
  if (current !== null && !out.some((o) => o.value === current)) {
    out.push({ value: current, label: copy.session.efforts[current] });
  }
  return out;
};

/** Claude's five levels; kept for callers that predate the catalogue. */
export const effortOptions = (): ControlOption[] => effortOptionsFor('claude', null, []);

export interface SessionSettingsPick {
  model: string | null;
  effort: Effort | null;
}

/**
 * Settings carried across an agent or model change (Spawn modal): a model the new agent does not list resets
 * to the CLI default, and so does an effort the chosen model lacks (Codex `gpt-5.5` has no `ultra`).
 */
export const reconcileSessionSettings = <T extends SessionSettingsPick>(
  agent: Agent,
  settings: T,
  catalogue: readonly ModelInfo[],
): T => {
  const model =
    settings.model !== null && modelOptionsFor(agent, null, catalogue).some((o) => o.value === settings.model)
      ? settings.model
      : null;
  const effort =
    settings.effort !== null && effortLevelsFor(agent, model, catalogue).includes(settings.effort)
      ? settings.effort
      : null;
  return { ...settings, model, effort };
};

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
  /** Permission-mode select (every structured runner: Claude stream, Codex app-server, Gemini / Cursor ACP). */
  mode: boolean;
  /** Model select (same runners). */
  model: boolean;
  /** The agent takes an effort at all (Spawn modal and Settings). */
  effort: boolean;
  /**
   * The effort can change per turn, so it belongs on the composer line too. Claude's applies at the next
   * relaunch and stays in Spawn / Settings (the 360px line has no room for a select that does nothing now).
   */
  liveEffort: boolean;
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
  liveEffort: false,
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
  // A structured runner takes `session.configure`: Claude's stream-json, Codex's app-server, Gemini's and
  // Cursor's ACP. A pty (the shell, or a CLI too old for its structured mode) has nothing to configure.
  const structured = claude || (streaming && session.agent !== 'shell');
  const heldByUser = session.state === 'paused' && session.pausedReason === 'user';
  return {
    mode: structured,
    model: structured,
    effort: structured && takesEffort(session.agent),
    liveEffort: structured && takesEffort(session.agent) && !claude,
    // Stop was gated on `streaming`, so codex / gemini / shell had no stop control at all even though the pty
    // branch has always written ^C. Every live runner mid-turn can be stopped.
    // A turn blocked on an approval (needs-you) is mid-turn too: Stop declines what is open and ends the turn,
    // which is what `session.interrupt` already does for open permission asks.
    stop: session.state === 'working' || session.state === 'needs-you',
    // Pausing means parking a `can_use_tool` request, which only the stream runner produces.
    pause: streaming && (session.state === 'working' || heldByUser),
    paused: heldByUser,
  };
};

export const hasControls = (c: SessionControls): boolean =>
  c.mode || c.model || c.effort || c.stop || c.pause;

/** Which spawn-time selects an agent tile exposes: every agent but the shell takes a mode and a model; effort per `takesEffort`. */
export const spawnControlsFor = (
  agent: Session['agent'],
): Pick<SessionControls, 'mode' | 'model' | 'effort'> => ({
  mode: agent !== 'shell',
  model: agent !== 'shell',
  effort: takesEffort(agent),
});
