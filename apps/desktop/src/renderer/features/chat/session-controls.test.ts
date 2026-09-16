import { copy, fixtures, type ModelInfo, type Session } from '@styx/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VALUE,
  STANDARD_EFFORTS,
  decodeEffort,
  decodeModel,
  decodePermissionMode,
  effortLevelsFor,
  effortOptions,
  effortOptionsFor,
  encodeNullable,
  hasControls,
  isLive,
  modelOptions,
  modelOptionsFor,
  nextPermissionMode,
  permissionModeHint,
  permissionModeOptions,
  permissionModeOptionsFor,
  reconcileSessionSettings,
  sessionControls,
  shortModelLabel,
  spawnControlsFor,
  takesEffort,
} from './session-controls';

const claude = (): Session => {
  const s = fixtures.demoReadModel().sessions.byId[fixtures.ids.session.claude];
  if (s === undefined) throw new Error('fixture');
  return s;
};

/** Codex `model/list` as the app-server runner stores it (docs/research/agent-parity.md §2.4), deliberately unsorted. */
const CODEX: ModelInfo[] = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: null,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'xhigh',
    isDefault: false,
    hidden: false,
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    description: 'Best for most work',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultEffort: 'low',
    isDefault: true,
    hidden: false,
  },
  {
    id: 'gpt-reserve',
    label: 'GPT Reserve',
    description: null,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    isDefault: false,
    hidden: true,
  },
];

describe('session controls (Claude Code parity, discrepancy #54)', () => {
  it('permission-mode options carry the §-style labels and hints as titles', () => {
    const opts = permissionModeOptions();
    expect(opts.map((o) => o.value)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
      'dontAsk',
      'auto',
    ]);
    expect(opts[0]).toEqual({
      value: 'default',
      label: copy.session.permissionModes.default,
      title: copy.session.permissionModeHints.default,
    });
  });

  it('model options: default + aliases; a full model name on the session is appended once', () => {
    expect(modelOptions(null).map((o) => o.value)).toEqual(['default', 'fable', 'opus', 'sonnet', 'haiku']);
    expect(modelOptions('opus').map((o) => o.value)).toEqual(['default', 'fable', 'opus', 'sonnet', 'haiku']);
    const full = modelOptions('claude-opus-4-1-20250805');
    expect(full.at(-1)).toEqual({ value: 'claude-opus-4-1-20250805', label: 'claude-opus-4-1-20250805' });
    expect(modelOptions('').map((o) => o.value)).toHaveLength(5);
    expect(modelOptions(null)[0]?.label).toBe('Default model');
    expect(modelOptions(null, true)[0]?.label).toBe('Default');
    expect(modelOptions('claude-fable-5-1', true).at(-1)).toEqual({
      value: 'claude-fable-5-1',
      label: 'Fable',
    });
    expect(modelOptions('claude-fable-5-1').at(-1)?.label).toBe('claude-fable-5-1');
    expect(modelOptions('custom-x', true).at(-1)?.label).toBe('custom-x');
    expect(permissionModeOptions(true).map((o) => o.label)).toEqual([
      'Ask',
      'Accept edits',
      'Plan',
      'Bypass',
      "Don't ask",
      'Auto',
    ]);
  });

  it('effort options: default + the five Claude levels (ultra belongs to the Codex models whose row lists it)', () => {
    expect(STANDARD_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortOptions().map((o) => o.value)).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortOptions()[5]?.label).toBe('Max');
  });

  it('encodes null as the default value and decodes unknown values safely', () => {
    expect(encodeNullable(null)).toBe(DEFAULT_VALUE);
    expect(encodeNullable('opus')).toBe('opus');
    expect(decodeModel('default')).toBeNull();
    expect(decodeModel('sonnet')).toBe('sonnet');
    expect(decodeEffort('default')).toBeNull();
    expect(decodeEffort('xhigh')).toBe('xhigh');
    expect(decodeEffort('bogus')).toBeNull();
    expect(decodePermissionMode('plan')).toBe('plan');
    expect(decodePermissionMode('bogus')).toBe('default');
  });

  it('⇧⇥ cycles default → acceptEdits → plan → default; other modes return to default', () => {
    expect(nextPermissionMode('default')).toBe('acceptEdits');
    expect(nextPermissionMode('acceptEdits')).toBe('plan');
    expect(nextPermissionMode('plan')).toBe('default');
    expect(nextPermissionMode('bypassPermissions')).toBe('default');
    expect(nextPermissionMode('dontAsk')).toBe('default');
    expect(nextPermissionMode('auto')).toBe('default');
  });

  it('live = process attached and not done', () => {
    expect(isLive({ pid: 4001, state: 'working' })).toBe(true);
    expect(isLive({ pid: null, state: 'working' })).toBe(false);
    expect(isLive({ pid: 4001, state: 'done' })).toBe(false);
  });

  it('claude shows mode/model/effort (+ stop and pause while working); structured runners show the same; every runner can stop', () => {
    const s = claude();
    expect(s.state).toBe('working');
    expect(sessionControls(s)).toEqual({
      mode: true,
      model: true,
      effort: true,
      liveEffort: false,
      stop: true,
      pause: true,
      paused: false,
    });
    expect(sessionControls({ ...s, state: 'idle' })).toEqual({
      mode: true,
      model: true,
      effort: true,
      liveEffort: false,
      stop: false,
      pause: false,
      paused: false,
    });
    // Cursor over ACP (stream): mode and model; ACP has no effort.
    expect(sessionControls({ ...s, agent: 'cursor' })).toEqual({
      mode: true,
      model: true,
      effort: false,
      liveEffort: false,
      stop: true,
      pause: true,
      paused: false,
    });
    // Codex over its app-server (stream): every setting applies at the next turn, effort included.
    expect(sessionControls({ ...s, agent: 'codex' })).toEqual({
      mode: true,
      model: true,
      effort: true,
      liveEffort: true,
      stop: true,
      pause: true,
      paused: false,
    });
    // A pty runner has no tool boundary to hold at and nothing to configure, but ^C has always worked.
    expect(sessionControls({ ...s, agent: 'codex', runner: 'pty' })).toEqual({
      mode: false,
      model: false,
      effort: false,
      liveEffort: false,
      stop: true,
      pause: false,
      paused: false,
    });
    expect(sessionControls({ ...s, agent: 'shell' })).toMatchObject({
      mode: false,
      model: false,
      effort: false,
    });
    // Held by the user: the control reads Resume, and Stop is gone because the turn is not running.
    expect(sessionControls({ ...s, state: 'paused', pausedReason: 'user' })).toMatchObject({
      stop: false,
      pause: true,
      paused: true,
    });
    // An error pause is a different thing: the banner owns it, not the chat control.
    expect(sessionControls({ ...s, state: 'paused', pausedReason: 'cli-missing' })).toMatchObject({
      pause: false,
      paused: false,
    });
    expect(sessionControls({ ...s, pid: null })).toEqual({
      mode: false,
      model: false,
      effort: false,
      liveEffort: false,
      stop: false,
      pause: false,
      paused: false,
    });
    expect(hasControls(sessionControls(s))).toBe(true);
    expect(hasControls(sessionControls(null))).toBe(false);
  });

  it('spawn-time selects follow the agent tile', () => {
    expect(spawnControlsFor('claude')).toEqual({ mode: true, model: true, effort: true });
    expect(spawnControlsFor('codex')).toEqual({ mode: true, model: true, effort: true });
    expect(spawnControlsFor('gemini')).toEqual({ mode: true, model: true, effort: false });
    expect(spawnControlsFor('cursor')).toEqual({ mode: true, model: true, effort: false });
    expect(spawnControlsFor('shell')).toEqual({ mode: false, model: false, effort: false });
    expect(takesEffort('claude')).toBe(true);
    expect(takesEffort('codex')).toBe(true);
    expect(takesEffort('gemini')).toBe(false);
  });
});

describe('agent-aware pickers (discrepancy #83)', () => {
  it('a catalogue drives the model list: default first, labels from the CLI, hidden rows only when current', () => {
    expect(modelOptionsFor('codex', null, CODEX)).toEqual([
      { value: 'default', label: 'Default model' },
      { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
      { value: 'gpt-5.5', label: 'GPT-5.5' },
    ]);
    expect(modelOptionsFor('codex', 'gpt-reserve', CODEX).map((o) => o.value)).toEqual([
      'default',
      'gpt-6-astra',
      'gpt-5.5',
      'gpt-reserve',
    ]);
    expect(modelOptionsFor('codex', 'gpt-reserve', CODEX).at(-1)?.label).toBe('GPT Reserve');
    // The short form keeps the CLI's labels (they are already short); the default entry shortens.
    expect(modelOptionsFor('codex', null, CODEX, true)[0]?.label).toBe('Default');
    expect(modelOptionsFor('codex', null, CODEX, true)[1]?.label).toBe('GPT-6 Astra');
    // A model the CLI never listed (older config) is appended as-is so the select stays truthful.
    expect(modelOptionsFor('codex', 'o3-legacy', CODEX).at(-1)).toEqual({
      value: 'o3-legacy',
      label: 'o3-legacy',
    });
    // The Claude aliases never leak into another agent's list.
    expect(modelOptionsFor('codex', null, []).map((o) => o.value)).toEqual(['default']);
  });

  it('Gemini / Cursor without a catalogue: Default model plus the id the session already carries', () => {
    expect(modelOptionsFor('gemini', null, [])).toEqual([{ value: 'default', label: 'Default model' }]);
    expect(modelOptionsFor('cursor', 'gpt-5', [], true)).toEqual([
      { value: 'default', label: 'Default' },
      { value: 'gpt-5', label: 'gpt-5' },
    ]);
    // A catalogue the ACP runner publishes takes over, same rule as Codex.
    expect(modelOptionsFor('gemini', null, [CODEX[1] as ModelInfo]).map((o) => o.value)).toEqual([
      'default',
      'gpt-6-astra',
    ]);
  });

  it('Claude keeps its aliases even alongside a catalogue-free session', () => {
    expect(modelOptionsFor('claude', null, [])).toEqual(modelOptions(null));
    expect(modelOptionsFor('claude', 'claude-fable-5-1', [], true).at(-1)?.label).toBe('Fable');
  });

  it('shortModelLabel maps a catalogue id to its label, an alias to its short form, anything else as-is', () => {
    expect(shortModelLabel('gpt-6-astra', CODEX)).toBe('GPT-6 Astra');
    expect(shortModelLabel('claude-fable-5-1', CODEX)).toBe('Fable');
    expect(shortModelLabel('claude-fable-5-1')).toBe('Fable');
    expect(shortModelLabel('o3-legacy', CODEX)).toBe('o3-legacy');
  });

  it('efforts follow the selected model (gpt-5.5 has no ultra); null follows the default model', () => {
    expect(effortOptionsFor('codex', 'gpt-5.5', CODEX).map((o) => o.value)).toEqual([
      'default',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(effortOptionsFor('codex', null, CODEX).map((o) => o.value)).toEqual([
      'default',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(effortOptionsFor('codex', null, CODEX)[0]?.label).toBe('Default effort');
    expect(effortOptionsFor('codex', null, CODEX).at(-1)?.label).toBe('Ultra');
    // An unknown model id follows the default row rather than inventing levels.
    expect(effortLevelsFor('codex', 'o3-legacy', CODEX)).toEqual(CODEX[1]?.efforts);
    // An effort already on the session that the model lacks is appended so the select shows it.
    expect(effortOptionsFor('codex', 'gpt-5.5', CODEX, 'ultra').at(-1)).toEqual({
      value: 'ultra',
      label: 'Ultra',
    });
    expect(effortOptionsFor('codex', 'gpt-5.5', CODEX, 'high')).toHaveLength(5);
    // No catalogue yet: Codex takes the standard five.
    expect(effortLevelsFor('codex', null, [])).toEqual(STANDARD_EFFORTS);
    expect(effortLevelsFor('claude', null, CODEX)).toEqual(CODEX[1]?.efforts);
  });

  it('Gemini / Cursor take no effort (ACP has none): only the default entry, and no levels', () => {
    expect(effortLevelsFor('gemini', null, [])).toEqual([]);
    expect(effortLevelsFor('cursor', 'gpt-6-astra', CODEX)).toEqual([]);
    expect(effortOptionsFor('gemini', null, []).map((o) => o.value)).toEqual(['default']);
    expect(effortLevelsFor('shell', null, [])).toEqual([]);
  });

  it('permission-mode hints: Claude wording for Claude, the §5–§6 mapping for Codex / Gemini / Cursor', () => {
    expect(permissionModeHint('claude', 'plan')).toBe(copy.session.permissionModeHints.plan);
    expect(permissionModeHint('shell', 'plan')).toBe(copy.session.permissionModeHints.plan);
    expect(permissionModeHint('codex', 'acceptEdits')).toBe(
      copy.session.permissionModeHintsByAgent.codex.acceptEdits,
    );
    expect(permissionModeHint('gemini', 'dontAsk')).toBe(
      copy.session.permissionModeHintsByAgent.gemini.dontAsk,
    );
    expect(permissionModeHint('cursor', 'auto')).toBe(copy.session.permissionModeHintsByAgent.cursor.auto);
    const codex = permissionModeOptionsFor('codex', true);
    expect(codex.map((o) => o.label)).toEqual(permissionModeOptions(true).map((o) => o.label));
    expect(codex[0]?.title).toBe(copy.session.permissionModeHintsByAgent.codex.default);
    expect(permissionModeOptionsFor('claude')).toEqual(permissionModeOptions());
  });

  it('reconcile: a model the new agent does not list resets, and so does an effort the model lacks', () => {
    const chosen = { model: 'opus', effort: 'max' as const, permissionMode: 'plan' as const };
    expect(reconcileSessionSettings('claude', chosen, [])).toEqual(chosen);
    // Claude alias → Codex: not a Codex model; the effort survives because the default row has max.
    expect(reconcileSessionSettings('codex', chosen, CODEX)).toEqual({
      ...chosen,
      model: null,
      effort: 'max',
    });
    expect(reconcileSessionSettings('codex', { model: 'gpt-5.5', effort: 'ultra' as const }, CODEX)).toEqual({
      model: 'gpt-5.5',
      effort: null,
    });
    expect(
      reconcileSessionSettings('codex', { model: 'gpt-6-astra', effort: 'ultra' as const }, CODEX),
    ).toEqual({
      model: 'gpt-6-astra',
      effort: 'ultra',
    });
    // Hidden rows are not offered, so a hidden model resets too.
    expect(reconcileSessionSettings('codex', { model: 'gpt-reserve', effort: null }, CODEX).model).toBeNull();
    expect(reconcileSessionSettings('cursor', chosen, [])).toEqual({ ...chosen, model: null, effort: null });
    expect(reconcileSessionSettings('shell', chosen, [])).toEqual({ ...chosen, model: null, effort: null });
  });
});
