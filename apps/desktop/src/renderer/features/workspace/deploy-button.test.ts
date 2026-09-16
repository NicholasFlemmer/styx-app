import { copy, fixtures, removeRows, type Deploy, type ReadModel } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { learnKey } from '../abilities/learn';
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

  it('acme-shop: three prod targets → the accent picker; the ones Styx has no command for are flagged to learn', () => {
    expect(deployButtonState(model, acme)).toEqual({
      kind: 'menu',
      live: true,
      label: copy.deploy.pick,
      options: [
        {
          targetId: ids.target.vercelProd,
          label: 'Vercel prod',
          name: 'Vercel',
          env: 'prod',
          prod: true,
          learn: false,
        },
        {
          targetId: ids.target.supabaseProd,
          label: 'Supabase prod',
          name: 'Supabase',
          env: 'prod',
          prod: true,
          learn: true,
        },
        {
          targetId: ids.target.awsProd,
          label: 'AWS acme-prod prod',
          name: 'AWS acme-prod',
          env: 'prod',
          prod: true,
          learn: true,
        },
      ],
    });
  });

  it('infra-tools: one prod target with no deploy command → "Deploy to live" that hands the first deploy to the agent', () => {
    expect(deployButtonState(model, ids.project.infraTools)).toEqual({
      kind: 'single',
      targetId: ids.target.infraAws,
      live: true,
      learn: true,
      label: 'Deploy to live · AWS acme-prod prod',
    });
  });

  it('a project with no targets at all asks to connect one', () => {
    const bare: ReadModel = {
      ...model,
      targets: removeRows(model.targets, [ids.target.infraAws, ids.target.infraGcp]),
    };
    expect(deployButtonState(bare, ids.project.infraTools)).toEqual({ kind: 'none' });
  });

  it('a GCP target with a remembered deploy command deploys directly, like a built-in one', () => {
    const gcp = model.targets.byId[ids.target.infraGcp];
    if (gcp === undefined) throw new Error('fixture');
    const withCommand: ReadModel = {
      ...model,
      targets: {
        ...removeRows(model.targets, [ids.target.infraAws]),
        byId: {
          ...removeRows(model.targets, [ids.target.infraAws]).byId,
          [gcp.id]: { ...gcp, config: { ...gcp.config, deployCommand: 'gcloud run deploy api --source .' } },
        },
      },
    };
    expect(deployButtonState(withCommand, ids.project.infraTools)).toEqual({
      kind: 'single',
      targetId: gcp.id,
      // The fixture's GCP target is staging, so it is the plain "Deploy · …", not "Deploy to live".
      live: false,
      learn: false,
      label: `Deploy · ${gcp.name} ${gcp.env}`,
    });
  });

  it('only non-prod targets → the plain "Deploy · Vercel preview"; several → a plain picker', () => {
    const noProd = removeRows(model.targets, [
      ids.target.vercelProd,
      ids.target.supabaseProd,
      ids.target.awsProd,
    ]);
    expect(deployButtonState({ ...model, targets: noProd }, acme)).toEqual({
      kind: 'menu',
      live: false,
      label: copy.deploy.pick,
      options: [
        expect.objectContaining({ label: 'Vercel preview', prod: false, learn: false }),
        expect.objectContaining({ label: 'GitHub acme/shop scm', prod: false, learn: true }),
      ],
    });
    const one: ReadModel = { ...model, targets: removeRows(noProd, [ids.target.github]) };
    expect(deployButtonState(one, acme)).toEqual({
      kind: 'single',
      targetId: ids.target.vercelPreview,
      live: false,
      learn: false,
      label: 'Deploy · Vercel preview',
    });
  });

  it('several prod targets → a picker with the prod rows only', () => {
    const prod = model.targets.byId[ids.target.blogVercel];
    if (prod === undefined) throw new Error('fixture');
    const second = { ...prod, id: 'target:second' as typeof prod.id, name: 'Vercel EU' };
    const preview = { ...prod, id: 'target:preview' as typeof prod.id, env: 'preview' as const };
    const two: ReadModel = {
      ...model,
      targets: {
        byId: { ...model.targets.byId, [second.id]: second, [preview.id]: preview },
        ids: [...model.targets.ids, second.id, preview.id],
      },
    };
    expect(deployButtonState(two, ids.project.blogV2)).toEqual({
      kind: 'menu',
      live: true,
      label: copy.deploy.pick,
      options: [
        { targetId: prod.id, label: 'Vercel prod', name: 'Vercel', env: 'prod', prod: true, learn: false },
        {
          targetId: second.id,
          label: 'Vercel EU prod',
          name: 'Vercel EU',
          env: 'prod',
          prod: true,
          learn: false,
        },
      ],
    });
  });

  it('while the agent works a first deploy out, the button reports it and opens that chat', () => {
    const learner = model.sessions.byId[ids.session.gemini];
    if (learner === undefined) throw new Error('fixture');
    const learning = { [learnKey.deploy(ids.target.infraAws)]: learner.id };
    expect(deployButtonState(model, ids.project.infraTools, learning)).toEqual({
      kind: 'learning',
      targetId: ids.target.infraAws,
      sessionId: learner.id,
      label: 'Deploying · AWS acme-prod prod',
    });
    // A finished session no longer counts; neither does one the model does not know.
    const finished: ReadModel = {
      ...model,
      sessions: {
        ...model.sessions,
        byId: { ...model.sessions.byId, [learner.id]: { ...learner, state: 'done', endedAt: DEMO_NOW } },
      },
    };
    expect(deployButtonState(finished, ids.project.infraTools, learning).kind).toBe('single');
    expect(deployButtonState(model, ids.project.infraTools, { 'deploy:x': learner.id }).kind).toBe('single');
    // A deploy in flight outranks a learning session.
    const inFlight: ReadModel = {
      ...model,
      deploys: { 'dep:1': deploy({ projectId: ids.project.infraTools, targetId: ids.target.infraAws }) },
    };
    expect(deployButtonState(inFlight, ids.project.infraTools, learning).kind).toBe('deploying');
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
    expect(deployButtonState(done, acme).kind).toBe('menu');
    const other: ReadModel = {
      ...model,
      deploys: { 'dep:1': deploy({ projectId: ids.project.blogV2, targetId: ids.target.blogVercel }) },
    };
    expect(deployButtonState(other, acme).kind).toBe('menu');
    expect(deployButtonState(other, ids.project.blogV2)).toMatchObject({
      kind: 'deploying',
      label: 'Deploying · Vercel prod…',
    });
  });
});
