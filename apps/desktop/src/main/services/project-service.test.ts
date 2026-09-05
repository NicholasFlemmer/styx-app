import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtures, type ProjectFileV1 } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../test-support';
import { STALE_MS, isSuggested, mergeCandidates, projectFileRules } from './project-service';

const { ids } = fixtures;
const NOW = fixtures.DEMO_NOW;
const DAY = 24 * 3_600_000;

describe('project.scan merge + suggestion logic', () => {
  it.each([
    ['remote + fresh', 'git@github.com:a/b.git', NOW - DAY, true],
    ['remote + stale', 'git@github.com:a/b.git', NOW - STALE_MS - DAY, true],
    ['no remote + fresh', null, NOW - 30 * DAY, true],
    ['no remote + stale (> 1 year)', null, NOW - STALE_MS - DAY, false],
    ['no remote + unknown mtime', null, null, false],
    ['no remote + exactly a year', null, NOW - STALE_MS, true],
  ])('%s → suggested=%s', (_label, remote, mtime, expected) => {
    expect(isSuggested(remote, mtime, NOW)).toBe(expected);
  });

  it('merges filesystem hits with IDE recents; scan wins on overlap, known projects drop, sorted by path', () => {
    const known = new Set(['/h/code/known']);
    expect(
      mergeCandidates(
        ['/h/code/zeta', '/h/code/alpha', '/h/code/known'],
        ['/h/work/ide-only', '/h/code/alpha', '/h/code/known'],
        known,
      ),
    ).toEqual([
      { path: '/h/code/alpha', source: 'scan' },
      { path: '/h/code/zeta', source: 'scan' },
      { path: '/h/work/ide-only', source: 'ide-recent' },
    ]);
    expect(mergeCandidates([], [], known)).toEqual([]);
  });
});

describe('project file policies.extra → projectRules', () => {
  const file: ProjectFileV1 = {
    version: 1,
    name: 'acme-shop',
    policies: {
      extra: [
        {
          id: 'sb-read',
          rule: {
            kind: 'auto-approve',
            match: { provider: ['supabase'] },
            scopes: ['read'],
            duration: 'session',
          },
          ruleText: 'Auto-approve Supabase reads',
        },
        {
          id: 'off',
          rule: { kind: 'ask', match: {}, scopes: ['delete'], requireMfa: true },
          ruleText: 'Always ask for deletes',
          enabled: false,
        },
      ],
    },
  };

  it('maps file rules to engine policies in file order with namespaced ids', () => {
    const rules = projectFileRules(file, NOW);
    expect(rules.map((r) => [r.id, r.ord, r.enabled, r.builtinKey])).toEqual([
      ['project:sb-read', 1, true, null],
      ['project:off', 2, false, null],
    ]);
    expect(projectFileRules({ version: 1, name: 'x' }, NOW)).toEqual([]);
  });

  it('an extra auto-approve rule in .styx/project.json auto-approves a matching request', async () => {
    const t = makeTestApp();
    const dir = mkdtempSync(join(tmpdir(), 'styx-pf-'));
    mkdirSync(join(dir, '.styx'));
    writeFileSync(join(dir, '.styx', 'project.json'), JSON.stringify(file));
    const project = t.app.repos.projects.get(ids.project.acmeShop);
    if (!project) throw new Error('fixture project');
    t.app.repos.projects.upsert({ ...project, path: dir });
    expect(t.app.projects.projectRules(project.id).map((r) => r.id)).toEqual([
      'project:sb-read',
      'project:off',
    ]);
    expect(t.app.projects.projectRules(project.id)).toBe(t.app.projects.projectRules(project.id)); // mtime cache

    const target = t.app.repos.targets.get(ids.target.supabaseProd);
    if (!target?.credentialRef) throw new Error('fixture target');
    // Supabase hands the agent the whole token, so on *prod* an auto rule still asks (+MFA); staging auto-issues.
    t.app.repos.targets.upsert({ ...target, env: 'staging' });
    await t.vault.set(target.credentialRef, JSON.stringify({ token: 'sbp_test' }));
    const out = await t.app.grants.request({
      sessionId: ids.session.gemini,
      targetId: ids.target.supabaseProd,
      scope: ['read'],
      reason: 'inspect schema',
      triggeredBy: 'mcp:request_access',
    });
    expect(out.kind).toBe('active');
    if (out.kind !== 'active') return;
    expect(out.decidedBy).toBe('policy');
    expect(out.grant.policyId).toBeNull(); // project rules are not `policies` rows; the audit cites the rule instead
    const requested = t.app.repos.audit.all().find((e) => e.action === 'requested' && e.grantId === out.grant.id);
    expect(requested?.detail).toMatchObject({ projectRule: 'project:sb-read' });

    // A write on prod still forces MFA → ask, even with the file rule present.
    const write = await t.app.grants.request({
      sessionId: ids.session.gemini,
      targetId: ids.target.supabaseProd,
      scope: ['write'],
      reason: 'migration',
      triggeredBy: 'mcp:request_access',
    });
    expect(write.kind).toBe('pending');
  });

  it('returns no rules when the project has no file', () => {
    const t = makeTestApp();
    expect(t.app.projects.projectRules(ids.project.blogV2)).toEqual([]);
    expect(t.app.projects.projectRules('nope')).toEqual([]);
  });
});

describe('project.create with createGithubRepo', () => {
  it('creates the repo through the GitHub target, adds origin, pushes, and audits `connected`', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const bare = mkdtempSync(join(tmpdir(), 'styx-bare-'));
    const fetchFake: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url === 'https://api.github.com/user') return Response.json({ login: 'me' });
      if (url === 'https://api.github.com/orgs/acme/repos')
        return Response.json(
          {
            full_name: 'acme/new-thing',
            clone_url: bare,
            html_url: 'https://github.com/acme/new-thing',
            default_branch: 'main',
          },
          { status: 201 },
        );
      return new Response('nope', { status: 404 });
    };
    const t = makeTestApp({ fetch: fetchFake });
    await t.app.git.init(bare);
    await t.app.git['git'].run(['config', 'receive.denyCurrentBranch', 'ignore'], bare);
    const gh = t.app.repos.targets.get(ids.target.github);
    if (!gh?.credentialRef) throw new Error('fixture github target');
    t.app.repos.targets.upsert({ ...gh, config: { ...gh.config, owner: 'acme' } });
    await t.vault.set(gh.credentialRef, JSON.stringify({ token: 'gh_test' }));

    const location = mkdtempSync(join(tmpdir(), 'styx-new-'));
    const project = await t.app.projects.create({
      name: 'new-thing',
      location,
      gitInit: true,
      template: null,
      copyTargetsFrom: null,
      createGithubRepo: true,
    });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', 'https://api.github.com/user'],
      ['POST', 'https://api.github.com/orgs/acme/repos'],
    ]);
    expect(calls[1]?.body).toEqual({ name: 'new-thing', private: true, auto_init: false });
    const remotes = await t.app.git.remotes(project.path);
    expect(remotes.map((r) => [r.name, r.url])).toEqual([['origin', bare]]);
    expect(await t.app.git.headCommit(bare)).toBe(await t.app.git.headCommit(project.path)); // initial push landed
    expect(t.app.repos.repos.byProject(project.id)?.remotes).toEqual([{ name: 'origin', url: bare }]);
    const entry = t.app.repos.audit.all().find((e) => e.action === 'connected' && e.projectId === project.id);
    expect(entry?.detail).toMatchObject({ repo: 'acme/new-thing' });
    expect(entry?.targetId).toBe(gh.id);
  });

  it('fails with provider-error when no GitHub target is connected', async () => {
    const t = makeTestApp({ fixture: 'empty' });
    const location = mkdtempSync(join(tmpdir(), 'styx-new-'));
    await expect(
      t.app.projects.create({
        name: 'lonely',
        location,
        gitInit: true,
        template: null,
        copyTargetsFrom: null,
        createGithubRepo: true,
      }),
    ).rejects.toMatchObject({ code: 'provider-error' });
  });

  it('project.templates lists built-ins plus styx-template repos in the target org', async () => {
    const fetchFake: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/search/repositories?q=topic%3Astyx-template%20org%3Aacme'))
        return Response.json({ items: [{ name: 'svc-template', full_name: 'acme/svc-template' }] });
      return new Response('nope', { status: 404 });
    };
    const t = makeTestApp({ fetch: fetchFake });
    const gh = t.app.repos.targets.get(ids.target.github);
    if (!gh?.credentialRef) throw new Error('fixture github target');
    t.app.repos.targets.upsert({ ...gh, config: { ...gh.config, owner: 'acme' } });
    await t.vault.set(gh.credentialRef, JSON.stringify({ token: 'gh_test' }));
    const r = await t.app.bus.dispatch(t.sender, 'project.templates', {});
    expect(r).toEqual({
      ok: true,
      value: {
        builtins: ['node', 'python', 'go', 'rust', 'static'],
        org: [{ name: 'svc-template', fullName: 'acme/svc-template' }],
      },
    });
    const none = makeTestApp({ fixture: 'empty' });
    expect(await none.app.bus.dispatch(none.sender, 'project.templates', {})).toMatchObject({
      ok: true,
      value: { org: [] },
    });
  });
});
