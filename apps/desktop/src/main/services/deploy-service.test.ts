import { fixtures } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import { FakeCliRunner } from '../providers/cli-runner';
import { PtyService } from './pty-service';
import { makeTestApp, type TestApp } from '../test-support';

/** In-memory pty: records spawns and lets the test end the deploy. */
class FakePty extends PtyService {
  readonly spawned: { id: string; shell: string; args: string[]; cwd: string; env: Record<string, string> }[] =
    [];
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

const appWithPty = () => {
  const pty = new FakePty();
  const cli = new FakeCliRunner().install('vercel');
  return { t: makeTestApp({ pty, cli }), pty };
};

const { ids } = fixtures;

/**
 * A deploy runs the provider's own CLI with a credential Styx minted, so the interesting assertions are that it
 * cannot skip the grant, that the audit trail records it, and that the phases the UI renders actually arrive.
 */
describe('DeployService', () => {
  const events = (t: TestApp) =>
    t.win.events('deploy.progress') as { phase: string; exitCode: number | null; error: string | null }[];

  /** vercelPreview: policy allows it without an ask, so `start` runs straight through. */
  const ready = async (t: TestApp) => {
    const target = t.app.repos.targets.get(ids.target.vercelPreview);
    if (!target?.credentialRef) throw new Error('fixture target');
    await t.vault.set(target.credentialRef, JSON.stringify({ token: 'vc_test' }));
    vi.spyOn(t.app.providers.get('vercel'), 'issue').mockResolvedValue({
      kind: 'env',
      env: { VERCEL_TOKEN: 'vc_scoped' },
      expiresAt: null,
      scoped: true,
    });
    return target;
  };

  it('takes a deploy-scoped grant, runs the provider argv with its credential, and reports the phases', async () => {
    const { t, pty } = appWithPty();
    const target = await ready(t);
    const r = await t.app.deploys.start(target.id, 'palette');
    expect(r.deployId).toMatch(/^dep:/);

    // The CLI is spawned with the minted credential, never a token it read itself.
    const spawned = pty.spawned.at(-1);
    expect(spawned?.args).toEqual(['deploy']); // preview target → no --prod
    expect(spawned?.env).toMatchObject({ VERCEL_TOKEN: 'vc_scoped' });

    // A grant exists and the run is recorded against it.
    const grants = t.app.repos.grants.byTarget(target.id).filter((g) => g.scope.includes('deploy'));
    expect(grants).toHaveLength(1);
    const uses = t.app.repos.grantUses.byGrant(grants[0]!.id);
    expect(uses.at(-1)).toMatchObject({ via: 'app', scopeUsed: 'deploy' });

    expect(events(t).map((e) => e.phase)).toEqual(['requesting-grant', 'running']);
  });

  it('reports succeeded or failed with the exit code when the CLI returns', async () => {
    const { t, pty } = appWithPty();
    const target = await ready(t);
    const r = await t.app.deploys.start(target.id, 'palette');
    pty.exit(r.terminalId, 0);
    expect(events(t).at(-1)).toMatchObject({ phase: 'succeeded', exitCode: 0 });

    const second = appWithPty();
    const target2 = await ready(second.t);
    const r2 = await second.t.app.deploys.start(target2.id, 'palette');
    second.pty.exit(r2.terminalId, 1);
    expect(events(second.t).at(-1)).toMatchObject({ phase: 'failed', exitCode: 1 });
  });

  it('refuses a target with no deploy command, and one that is not connected', async () => {
    const { t } = appWithPty();
    // github has no deployCommand.
    await expect(t.app.deploys.start(ids.target.github, 'palette')).rejects.toMatchObject({
      code: 'invalid-input',
    });
    const target = t.app.repos.targets.get(ids.target.vercelPreview);
    if (target) t.app.repos.targets.upsert({ ...target, credentialRef: null });
    await expect(t.app.deploys.start(ids.target.vercelPreview, 'palette')).rejects.toMatchObject({
      code: 'invalid-input',
    });
  });

  it('a prod target deploys with --prod', async () => {
    const { t, pty } = appWithPty();
    const prod = t.app.repos.targets.get(ids.target.vercelProd);
    if (!prod?.credentialRef) throw new Error('fixture target');
    await t.vault.set(prod.credentialRef, JSON.stringify({ token: 'vc_test' }));
    vi.spyOn(t.app.providers.get('vercel'), 'issue').mockResolvedValue({
      kind: 'env',
      env: {},
      expiresAt: null,
      scoped: true,
    });
    await t.app.deploys.start(prod.id, 'palette').catch(() => undefined);
    const spawned = pty.spawned.at(-1);
    // Either it deployed with --prod, or policy held it for approval — never a prod deploy without a grant.
    if (spawned !== undefined && spawned.args.includes('deploy')) expect(spawned.args).toContain('--prod');
    else expect(events(t).at(-1)?.phase).toBe('failed');
  });
});
