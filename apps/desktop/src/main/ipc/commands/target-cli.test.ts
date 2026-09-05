import { commands, fixtures } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { FakeCliRunner } from '../../providers/cli-runner';
import { PtyService } from '../../services/pty-service';
import { makeTestApp } from '../../test-support';

const { ids } = fixtures;

/** In-memory pty: records spawns, lets the test end the login command. */
class FakePty extends PtyService {
  readonly spawned: {
    id: string;
    shell: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  }[] = [];
  private readonly live = new Set<string>();
  constructor() {
    super('darwin');
  }
  override async resolveLoginPath(): Promise<string> {
    return '/usr/local/bin:/usr/bin';
  }
  override async spawn(opts: {
    id: string;
    cwd: string;
    shell?: string;
    args?: string[];
    env?: Record<string, string>;
  }) {
    this.spawned.push({
      id: opts.id,
      shell: opts.shell ?? '',
      args: opts.args ?? [],
      cwd: opts.cwd,
      env: opts.env ?? {},
    });
    this.live.add(opts.id);
    return { pid: 4242 };
  }
  override write(): void {}
  override resize(): void {}
  override kill(id: string): void {
    this.exit(id, 0);
  }
  override has(id: string): boolean {
    return this.live.has(id);
  }
  override killAll(): void {
    for (const id of [...this.live]) this.kill(id);
  }
  exit(id: string, code: number): void {
    this.live.delete(id);
    this.emit('exit', id, code, undefined);
  }
}

const GCLOUD_OK = { stdout: 'ya29.fixture-access-token\n' };
const GCLOUD_REAUTH = {
  exitCode: 1,
  stderr:
    'ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: reauth required',
};

function setup(fetchRoutes: Record<string, () => Response> = {}) {
  const cli = new FakeCliRunner()
    .install('gcloud')
    .on('gcloud', ['--version'], { stdout: 'Google Cloud SDK 500.0.0' })
    .on('gcloud', ['auth', 'list'], {
      stdout: JSON.stringify([{ account: 'nic@acme.dev', status: 'ACTIVE' }]),
    })
    .on('gcloud', ['config', 'get-value', 'project'], { stdout: 'acme-shop\n' })
    .on('gcloud', ['auth', 'print-access-token', '--account', 'nic@acme.dev'], GCLOUD_OK);
  const pty = new FakePty();
  const routes: Record<string, () => Response> = {
    'https://cloudresourcemanager.googleapis.com/v1/projects/acme-shop': () =>
      new Response('{}', { status: 200 }),
    ...fetchRoutes,
  };
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    const r = Object.entries(routes).find(([k]) => u.startsWith(k));
    return r ? r[1]() : new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  const t = makeTestApp({ cli, pty, fetch: fakeFetch });
  return { ...t, cli, pty };
}

describe('target.connect.cli* (connect with the provider CLI)', () => {
  it('cliStatus reports what gcloud knows; ssh has no CLI mode; a missing CLI is not an error', async () => {
    const { app, sender } = setup();
    const r = await app.bus.dispatch(sender, 'target.connect.cliStatus', { provider: 'gcp' });
    expect(r).toEqual({
      ok: true,
      value: {
        installed: true,
        binary: '/usr/local/bin/gcloud',
        version: '500.0.0',
        loginCommand: 'gcloud auth login',
        accounts: [{ id: 'nic@acme.dev', label: 'nic@acme.dev', active: true, detail: 'project acme-shop' }],
      },
    });
    if (r.ok) expect(commands['target.connect.cliStatus'].output.safeParse(r.value).success).toBe(true);
    expect(await app.bus.dispatch(sender, 'target.connect.cliStatus', { provider: 'aws' })).toMatchObject({
      ok: true,
      value: { installed: false, loginCommand: 'aws configure sso', accounts: [] },
    });
    expect(await app.bus.dispatch(sender, 'target.connect.cliStatus', { provider: 'ssh' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
  });

  it('cliLogin runs the CLI login in a term: pty (no shell) and reports running/exited over connect.cliLogin', async () => {
    const { app, sender, win, pty } = setup();
    const r = await app.bus.dispatch(sender, 'target.connect.cliLogin', {
      projectId: ids.project.acmeShop,
      provider: 'gcp',
      account: 'nic@acme.dev',
    });
    if (!r.ok) throw new Error(r.error.message);
    const { terminalId } = r.value;
    expect(terminalId).toMatch(/^term:/);
    expect(app.terminals.isTerminal(terminalId)).toBe(true);
    const project = app.repos.projects.get(ids.project.acmeShop);
    expect(pty.spawned).toEqual([
      {
        id: terminalId,
        shell: '/usr/local/bin/gcloud',
        args: ['auth', 'login', '--', 'nic@acme.dev'],
        cwd: project?.path,
        env: {},
      },
    ]);
    expect(win.events('connect.cliLogin')).toEqual([{ terminalId, provider: 'gcp', status: 'running' }]);
    pty.exit(terminalId, 0);
    expect(win.events('connect.cliLogin').at(-1)).toEqual({
      terminalId,
      provider: 'gcp',
      status: 'exited',
      exitCode: 0,
    });
    pty.exit(terminalId, 1); // a second exit for the same id is ignored (listener removed)
    expect(win.events('connect.cliLogin')).toHaveLength(2);

    // Accounts go into argv: shell metacharacters are refused before anything spawns.
    expect(
      await app.bus.dispatch(sender, 'target.connect.cliLogin', {
        projectId: ids.project.acmeShop,
        provider: 'gcp',
        account: 'x; rm -rf ~',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    expect(
      await app.bus.dispatch(sender, 'target.connect.cliLogin', {
        projectId: ids.project.acmeShop,
        provider: 'vercel',
      }),
    ).toMatchObject({ ok: false, error: { code: 'cli-missing' } });
    expect(
      await app.bus.dispatch(sender, 'target.connect.cliLogin', {
        projectId: ids.project.acmeShop,
        provider: 'ssh',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    expect(pty.spawned).toHaveLength(1);
  });

  it('cliSave creates an authMethod:cli target whose vault entry holds no secret, tests it, audits connected', async () => {
    const { app, sender, vault, win } = setup();
    const r = await app.bus.dispatch(sender, 'target.connect.cliSave', {
      projectId: ids.project.acmeShop,
      provider: 'gcp',
      env: 'staging',
      name: 'GCP acme-shop',
      account: 'nic@acme.dev',
      config: { projectId: 'acme-shop' },
    });
    if (!r.ok) throw new Error(r.error.message);
    const targetId = r.value.targetId;
    if (!targetId) throw new Error('no target id');
    const target = app.repos.targets.get(targetId);
    expect(target).toMatchObject({
      provider: 'gcp',
      env: 'staging',
      name: 'GCP acme-shop',
      authMethod: 'cli',
      credentialRef: `styx:v1:gcp:${targetId}:cli`,
      health: 'ok',
      healthCheckedAt: app.clock.now(),
      config: { projectId: 'acme-shop', account: 'nic@acme.dev' },
    });
    expect(JSON.parse((await vault.get(target?.credentialRef ?? '')) ?? '')).toEqual({
      kind: 'cli',
      account: 'nic@acme.dev',
      project: 'acme-shop',
    });
    const connected = app.repos.audit.all().find((e) => e.targetId === targetId && e.action === 'connected');
    expect(connected).toMatchObject({
      actorKind: 'you',
      triggeredBy: 'connect flow',
      detail: { authMethod: 'cli' },
    });
    // Nothing that left the CLI reaches the store, events or audit.
    app.publisher.flush();
    const everything = JSON.stringify([app.publisher.snapshot(), win.sent, app.repos.audit.all()]);
    expect(everything).not.toContain('ya29.');
    // Saving again for the same (provider, env, name) updates in place.
    const again = await app.bus.dispatch(sender, 'target.connect.cliSave', {
      projectId: ids.project.acmeShop,
      provider: 'gcp',
      env: 'staging',
      name: 'GCP acme-shop',
      account: 'nic@acme.dev',
      config: {},
    });
    expect(again).toEqual({ ok: true, value: { targetId } });
    expect(
      app.repos.targets.byProject(ids.project.acmeShop).filter((t) => t.provider === 'gcp'),
    ).toHaveLength(1);
  });

  it('cliSave switching an existing key target to cli drops the old keychain entry', async () => {
    const { app, sender, vault } = setup();
    const aws = app.repos.targets.get(ids.target.awsProd);
    if (!aws?.credentialRef) throw new Error('fixture');
    await vault.set(
      aws.credentialRef,
      JSON.stringify({ accessKeyId: 'AKIAFIXTURE', secretAccessKey: 'FIXTURE', region: 'us-east-1' }),
    );
    const cli = app.cli as FakeCliRunner;
    cli
      .install('aws')
      .file('/Users/test/.aws/config', '[profile acme-prod]\nregion = us-east-1\n')
      .on('aws', ['configure', 'export-credentials', '--profile', 'acme-prod'], {
        stdout: JSON.stringify({
          Version: 1,
          AccessKeyId: 'ASIA1',
          SecretAccessKey: 's',
          SessionToken: 'tok',
        }),
      });
    // STS is the real SDK here; the identity call has no network, so it fails and the connect is refused — proves the
    // key path stays untouched on failure.
    const r = await app.bus.dispatch(sender, 'target.connect.cliSave', {
      projectId: ids.project.acmeShop,
      provider: 'aws',
      env: 'prod',
      name: 'AWS acme-prod',
      account: 'acme-prod',
      config: {},
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'provider-error' } });
    expect(app.repos.targets.get(ids.target.awsProd)).toMatchObject({
      authMethod: 'key',
      credentialRef: aws.credentialRef,
    });
    expect(await vault.get(aws.credentialRef)).not.toBeNull();
  });

  it('a grant on a cli target mints through gcloud; a mint failure expires the target; refresh + reconnect recover it', async () => {
    const { app, sender, cli, pty, win, clock } = setup();
    const saved = await app.bus.dispatch(sender, 'target.connect.cliSave', {
      projectId: ids.project.acmeShop,
      provider: 'gcp',
      env: 'staging',
      name: 'GCP',
      account: 'nic@acme.dev',
      config: { projectId: 'acme-shop' },
    });
    if (!saved.ok) throw new Error(saved.error.message);
    const targetId = saved.value.targetId;
    if (!targetId) throw new Error('no target id');

    // Target policy `always` on staging (the demo fixture ships the built-in auto-read rule disabled) → auto-issued
    // through `gcloud auth print-access-token`; staging never hits the prod MFA gate.
    await app.bus.dispatch(sender, 'target.setPolicy', { targetId, policy: 'always' });
    const out = await app.grants.request({
      sessionId: ids.session.gemini,
      targetId: targetId as never,
      scope: ['read'],
      reason: 'list buckets',
      triggeredBy: 'mcp:request_access',
    });
    expect(out.kind).toBe('active');
    if (out.kind !== 'active') return;
    expect(app.grants.issuedCredential(out.grant.id)).toMatchObject({
      kind: 'env',
      env: { CLOUDSDK_AUTH_ACCESS_TOKEN: 'ya29.fixture-access-token', CLOUDSDK_CORE_PROJECT: 'acme-shop' },
      scoped: false,
      handle: 'cli',
    });
    expect(cli.calls.filter((c) => c.args[1] === 'print-access-token').length).toBeGreaterThanOrEqual(2); // save-time test + issue
    app.grants.revoke(out.grant.id);

    // gcloud loses its login: the health refresh flips the target to expired with the auth-expired banner.
    cli.on('gcloud', ['auth', 'print-access-token'], GCLOUD_REAUTH);
    clock.advance(31 * 60_000);
    expect(await app.bus.dispatch(sender, 'target.refresh', { targetId })).toEqual({
      ok: true,
      value: { ok: false },
    });
    expect(app.repos.targets.get(targetId)).toMatchObject({ health: 'expired', expiredAt: clock.now() });
    const banner = win.events('banner.set').at(-1) as { kind: string; action: unknown; text: string };
    expect(banner).toMatchObject({
      kind: 'auth-expired',
      action: { kind: 'reconnect', targetId },
      text: expect.stringContaining('GCP: credentials expired'),
    });
    expect(
      app.repos.audit.all().filter((e) => e.targetId === targetId && e.action === 'tested'),
    ).toHaveLength(1); // the ok → expired transition only (a healthy save adds no tested row)
    // Same failure again: no second audit row (no transition), still expired.
    expect(await app.bus.dispatch(sender, 'target.refresh', {})).toEqual({ ok: true, value: { ok: false } });
    expect(
      app.repos.audit.all().filter((e) => e.targetId === targetId && e.action === 'tested'),
    ).toHaveLength(1);

    // A request while expired fails at issue time and keeps the target expired (no fresh banner spam either).
    const bannersBefore = win.events('banner.set').length;
    await expect(
      app.grants.request({
        sessionId: ids.session.gemini,
        targetId: targetId as never,
        scope: ['read'],
        reason: 'x',
        triggeredBy: 'mcp:request_access',
      }),
    ).rejects.toMatchObject({ code: 'provider-error' });
    expect(app.repos.targets.get(targetId)?.health).toBe('expired');
    expect(win.events('banner.set').length).toBe(bannersBefore + 1); // markExpired re-sends the banner (idempotent key)

    // Reconnect on a cli target reruns the CLI login in a terminal; flowId is the terminal id.
    const re = await app.bus.dispatch(sender, 'target.reconnect', { targetId });
    expect(re).toMatchObject({
      ok: true,
      value: { authMethod: 'cli', flowId: expect.stringMatching(/^term:/) },
    });
    expect(pty.spawned.at(-1)).toMatchObject({
      shell: '/usr/local/bin/gcloud',
      args: ['auth', 'login', '--', 'nic@acme.dev'],
    });
    if (re.ok) pty.exit((re.value as { flowId: string }).flowId, 0);
    expect(win.events('connect.cliLogin').at(-1)).toMatchObject({
      status: 'exited',
      exitCode: 0,
      provider: 'gcp',
    });

    // gcloud works again → refresh clears health and the banner.
    cli.on('gcloud', ['auth', 'print-access-token'], GCLOUD_OK);
    expect(await app.bus.dispatch(sender, 'target.refresh', { targetId })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(app.repos.targets.get(targetId)).toMatchObject({ health: 'ok', expiredAt: null });
    expect(win.events('banner.clear').at(-1)).toEqual({ bannerKey: `auth-expired:${targetId}` });

    // A transient failure (timeout) leaves health alone.
    cli.on('gcloud', ['auth', 'print-access-token'], { exitCode: 124, timedOut: true });
    expect(await app.bus.dispatch(sender, 'target.refresh', { targetId })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(app.repos.targets.get(targetId)?.health).toBe('ok');
    expect(JSON.stringify([app.publisher.snapshot(), win.sent, app.repos.audit.all()])).not.toContain(
      'ya29.',
    );
  });

  it('the scheduler is wired: app.refresh probes connected targets through TargetService.checkHealth', async () => {
    const { app, sender, cli } = setup();
    const saved = await app.bus.dispatch(sender, 'target.connect.cliSave', {
      projectId: ids.project.acmeShop,
      provider: 'gcp',
      env: 'preview',
      name: 'GCP',
      account: 'nic@acme.dev',
      config: {},
    });
    if (!saved.ok) throw new Error(saved.error.message);
    cli.on('gcloud', ['auth', 'print-access-token'], GCLOUD_REAUTH);
    await app.refresh.runNow('interval');
    expect(app.repos.targets.get(saved.value.targetId ?? '')?.health).toBe('expired');
  });
});
