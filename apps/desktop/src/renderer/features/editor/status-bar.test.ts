import { copy, fixtures, type Deploy, type DevRun, type DeviceSession, type ReadModel } from '@styx/core';
import { describe, expect, it } from 'vitest';
import {
  editorReadoutItems,
  editorStatusLabel,
  statusBarDeploy,
  statusBarDevice,
  statusBarRun,
  statusBarTargets,
} from './status-bar';

const { ids, DEMO_NOW } = fixtures;
const acme = ids.project.acmeShop;

const run = (over: Partial<DevRun> = {}): DevRun => ({
  projectId: acme,
  runId: 'run:1',
  terminalId: 'term:1',
  command: 'pnpm dev',
  platform: 'web',
  phase: 'running',
  url: null,
  exitCode: null,
  startedAt: DEMO_NOW - 5_000,
  endedAt: null,
  ...over,
});

const deploy = (over: Partial<Deploy> = {}): Deploy => ({
  deployId: 'dep:1',
  targetId: ids.target.vercelProd,
  projectId: acme,
  phase: 'running',
  terminalId: 'term:2',
  exitCode: null,
  error: null,
  startedAt: DEMO_NOW - 60_000,
  endedAt: null,
  ...over,
});

describe('statusBarTargets (prototype)', () => {
  it('acme-shop: the open Vercel prod grant and the Supabase target Codex is waiting on', () => {
    expect(statusBarTargets(fixtures.demoReadModel(), acme, DEMO_NOW)).toEqual([
      'Vercel prod · open 58m',
      'Supabase · locked',
    ]);
  });
});

describe('statusBarRun', () => {
  it.each([
    ['no run', null, []],
    ['starting, no URL yet', run({ phase: 'starting' }), [copy.workspace.run.statusBarNoUrl]],
    ['running, no URL', run(), ['dev · running']],
    [
      'running with the URL it printed',
      run({ url: 'http://localhost:3999' }),
      ['dev · http://localhost:3999'],
    ],
    [
      'exited: the strip says so, the bar does not',
      run({ phase: 'exited', exitCode: 0, endedAt: DEMO_NOW }),
      [],
    ],
    ['an iOS run names the platform, not a URL', run({ platform: 'ios' }), ['Running · iOS']],
    [
      'an Android run with a Metro URL still names the platform',
      run({ platform: 'android', url: 'http://localhost:8081' }),
      ['Running · Android'],
    ],
  ])('%s', (_name, r, expected) => {
    expect(statusBarRun(r)).toEqual(expected);
  });
});

describe('statusBarDevice', () => {
  const device = (over: Partial<DeviceSession> = {}): DeviceSession => ({
    projectId: acme,
    platform: 'ios',
    deviceId: 'UDID-1',
    deviceName: 'iPhone 17 Pro',
    phase: 'ready',
    mirror: 'window',
    input: false,
    error: null,
    screen: null,
    startedAt: DEMO_NOW,
    ...over,
  });
  it.each([
    ['no device', null, []],
    ['booting', device({ phase: 'booting' }), ['iOS · iPhone 17 Pro']],
    ['mirrored', device(), ['iOS · iPhone 17 Pro']],
    ['android', device({ platform: 'android', deviceName: 'Pixel 8' }), ['Android · Pixel 8']],
    ['failed: the device row says so, the bar does not', device({ phase: 'failed', error: 'x' }), []],
    ['stopped', device({ phase: 'stopped' }), []],
  ])('%s', (_name, d, expected) => {
    expect(statusBarDevice(d)).toEqual(expected);
  });
});

describe('statusBarDeploy', () => {
  const model = fixtures.demoReadModel();
  it('nothing without an active deploy', () => {
    expect(statusBarDeploy(model, acme)).toEqual([]);
    const done: ReadModel = { ...model, deploys: { 'dep:1': deploy({ phase: 'succeeded', exitCode: 0 }) } };
    expect(statusBarDeploy(done, acme)).toEqual([]);
  });
  it('names the target of each deploy in flight, oldest first, for this project only', () => {
    const m: ReadModel = {
      ...model,
      deploys: {
        'dep:2': deploy({ deployId: 'dep:2', targetId: ids.target.vercelPreview, startedAt: DEMO_NOW }),
        'dep:1': deploy({ phase: 'requesting-grant' }),
        'dep:3': deploy({
          deployId: 'dep:3',
          projectId: ids.project.blogV2,
          targetId: ids.target.blogVercel,
        }),
      },
    };
    expect(statusBarDeploy(m, acme)).toEqual(['deploying · Vercel prod', 'deploying · Vercel preview']);
    expect(statusBarDeploy(m, ids.project.blogV2)).toEqual(['deploying · Vercel prod']);
  });
});

describe('editor readout', () => {
  it('prototype label and the owner-added extras', () => {
    expect(editorStatusLabel('lf', 'TS')).toBe('Monaco · LF · TS');
    expect(editorReadoutItems({ cursor: { line: 12, col: 4 }, wrap: true, readOnly: 'large' })).toEqual([
      'Ln 12, Col 4',
      copy.workspace.editorWrap,
      copy.workspace.editorReadOnly.large,
    ]);
    expect(editorReadoutItems({ cursor: null, wrap: false, readOnly: null })).toEqual([]);
  });
});
