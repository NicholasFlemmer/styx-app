import { copy, fixtures, removeRows, type Deploy, type ReadModel } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { deployButtonState, deployTargetLabel } from './deploy-button';

const { ids, DEMO_NOW } = fixtures;
const acme = ids.project.acmeShop;

const deploy = (over: Partial<Deploy> = {}): Deploy => ({
  deployId: 'dep:1',
  targetId: ids.target.vercelProd,
  projectId: acme,
  phase: 'running',
  terminalId: 'term:1',
  exitCode: null,
  error: null,
  startedAt: DEMO_NOW - 60_000,
  endedAt: null,
  ...over,
});

describe('deployButtonState', () => {
  const model = fixtures.demoReadModel();

  it('labels the target the way the status bar does', () => {
    expect(deployTargetLabel({ name: 'Vercel', env: 'prod' })).toBe('Vercel prod');
  });

  it('acme-shop: one prod deployable → the accent "Deploy to live · Vercel prod"', () => {
    expect(deployButtonState(model, acme)).toEqual({
      kind: 'single',
      targetId: ids.target.vercelProd,
      live: true,
      label: 'Deploy to live · Vercel prod',
    });
  });

  it('infra-tools has aws + gcp only: nothing to deploy with', () => {
    expect(deployButtonState(model, ids.project.infraTools)).toEqual({ kind: 'none' });
  });

  it('only non-prod deployables → the plain "Deploy · Vercel preview"', () => {
    const noProd: ReadModel = { ...model, targets: removeRows(model.targets, [ids.target.vercelProd]) };
    expect(deployButtonState(noProd, acme)).toEqual({
      kind: 'single',
      targetId: ids.target.vercelPreview,
      live: false,
      label: 'Deploy · Vercel preview',
    });
  });

  it('several prod deployables → a picker, prod rows flagged, non-prod ones left out', () => {
    const preview = model.targets.byId[ids.target.vercelPreview];
    const prod = model.targets.byId[ids.target.vercelProd];
    if (preview === undefined || prod === undefined) throw new Error('fixture');
    const second = { ...prod, id: 'target:second' as typeof prod.id, name: 'Vercel EU' };
    const two: ReadModel = {
      ...model,
      targets: {
        byId: { ...model.targets.byId, [second.id]: second },
        ids: [...model.targets.ids, second.id],
      },
    };
    expect(deployButtonState(two, acme)).toEqual({
      kind: 'menu',
      live: true,
      label: copy.deploy.pick,
      options: [
        { targetId: ids.target.vercelProd, label: 'Vercel prod', prod: true },
        { targetId: second.id, label: 'Vercel EU prod', prod: true },
      ],
    });
    // Without any prod target, every deployable is offered.
    const noProd: ReadModel = {
      ...two,
      targets: {
        byId: {
          ...two.targets.byId,
          [prod.id]: { ...prod, env: 'staging' },
          [second.id]: { ...second, env: 'preview' },
        },
        ids: two.targets.ids,
      },
    };
    const st = deployButtonState(noProd, acme);
    expect(st.kind).toBe('menu');
    if (st.kind !== 'menu') throw new Error('menu');
    expect(st.live).toBe(false);
    expect(st.options.map((o) => o.label)).toEqual(['Vercel staging', 'Vercel preview', 'Vercel EU preview']);
  });

  it('a deploy in flight for a project target → "Deploying · Vercel prod…" with its ids', () => {
    const inFlight: ReadModel = { ...model, deploys: { 'dep:1': deploy() } };
    expect(deployButtonState(inFlight, acme)).toEqual({
      kind: 'deploying',
      targetId: ids.target.vercelProd,
      deployId: 'dep:1',
      label: 'Deploying · Vercel prod…',
    });
    // The newest active one wins when two are somehow in flight.
    const twoLive: ReadModel = {
      ...model,
      deploys: {
        'dep:1': deploy(),
        'dep:2': deploy({ deployId: 'dep:2', targetId: ids.target.vercelPreview, startedAt: DEMO_NOW }),
      },
    };
    expect(deployButtonState(twoLive, acme)).toMatchObject({ kind: 'deploying', deployId: 'dep:2' });
  });

  it('a finished deploy, or one for another project, does not count', () => {
    const done: ReadModel = {
      ...model,
      deploys: { 'dep:1': deploy({ phase: 'succeeded', exitCode: 0, endedAt: DEMO_NOW }) },
    };
    expect(deployButtonState(done, acme).kind).toBe('single');
    const other: ReadModel = {
      ...model,
      deploys: { 'dep:1': deploy({ projectId: ids.project.blogV2, targetId: ids.target.blogVercel }) },
    };
    expect(deployButtonState(other, acme).kind).toBe('single');
    expect(deployButtonState(other, ids.project.blogV2)).toMatchObject({
      kind: 'deploying',
      label: 'Deploying · Vercel prod…',
    });
  });
});
