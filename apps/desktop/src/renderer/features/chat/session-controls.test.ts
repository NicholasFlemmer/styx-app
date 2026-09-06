import { copy, fixtures, type Session } from '@styx/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VALUE,
  decodeEffort,
  decodeModel,
  decodePermissionMode,
  effortOptions,
  encodeNullable,
  hasControls,
  isLive,
  modelOptions,
  nextPermissionMode,
  permissionModeOptions,
  sessionControls,
  spawnControlsFor,
} from './session-controls';

const claude = (): Session => {
  const s = fixtures.demoReadModel().sessions.byId[fixtures.ids.session.claude];
  if (s === undefined) throw new Error('fixture');
  return s;
};

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
  });

  it('effort options: default + the five levels', () => {
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

  it('claude shows mode/model/effort (+ stop while working); cursor shows model only; others nothing', () => {
    const s = claude();
    expect(s.state).toBe('working');
    expect(sessionControls(s)).toEqual({ mode: true, model: true, effort: true, stop: true });
    expect(sessionControls({ ...s, state: 'idle' })).toEqual({
      mode: true,
      model: true,
      effort: true,
      stop: false,
    });
    expect(sessionControls({ ...s, agent: 'cursor' })).toEqual({
      mode: false,
      model: true,
      effort: false,
      stop: true,
    });
    expect(sessionControls({ ...s, agent: 'codex', runner: 'pty' })).toEqual({
      mode: false,
      model: false,
      effort: false,
      stop: false,
    });
    expect(sessionControls({ ...s, pid: null })).toEqual({
      mode: false,
      model: false,
      effort: false,
      stop: false,
    });
    expect(sessionControls(null)).toEqual({ mode: false, model: false, effort: false, stop: false });
    expect(hasControls(sessionControls(s))).toBe(true);
    expect(hasControls(sessionControls(null))).toBe(false);
  });

  it('spawn-time selects follow the agent tile', () => {
    expect(spawnControlsFor('claude')).toEqual({ mode: true, model: true, effort: true });
    expect(spawnControlsFor('cursor')).toEqual({ mode: false, model: true, effort: false });
    expect(spawnControlsFor('shell')).toEqual({ mode: false, model: false, effort: false });
  });
});
