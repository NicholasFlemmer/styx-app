import { commandResultSchema, commands, fixtures, type ProjectId } from '@styx/core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PtyService } from '../../services/pty-service';
import { makeTestApp } from '../../test-support';

class FakePty extends PtyService {
  private readonly live = new Set<string>();
  readonly killed: string[] = [];
  constructor() {
    super('darwin');
  }
  override async resolveLoginPath(): Promise<string> {
    return '/usr/bin';
  }
  override async spawn(opts: { id: string }) {
    this.live.add(opts.id);
    return { pid: 1 };
  }
  override write(): void {}
  override resize(): void {}
  override kill(id: string): void {
    this.killed.push(id);
    if (!this.live.delete(id)) return;
    this.emit('exit', id, 0, undefined);
  }
  override has(id: string): boolean {
    return this.live.has(id);
  }
  override killAll(): void {
    for (const id of [...this.live]) this.kill(id);
  }
}

const acme = fixtures.ids.project.acmeShop as ProjectId;

const setup = () => {
  const pty = new FakePty();
  const t = makeTestApp({ pty });
  const dir = mkdtempSync(join(tmpdir(), 'styx-run-ipc-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  const project = t.app.repos.projects.get(acme);
  if (!project) throw new Error('fixture project');
  t.app.repos.projects.upsert({ ...project, path: dir }, t.app.repos.projects.settings(acme));
  return { t, pty };
};

describe('run.* commands', () => {
  it('run.detect returns contract-valid suggestions', async () => {
    const { t } = setup();
    const r = await t.app.bus.dispatch(t.sender, 'run.detect', { projectId: acme });
    expect(commandResultSchema('run.detect').safeParse(r).success).toBe(true);
    expect(r).toEqual({
      ok: true,
      value: { suggestions: [{ command: 'pnpm dev', source: 'package.json' }], platforms: ['web'] },
    });
  });

  it('run.start → runs.set deltas; run.stop ends it; run.dismiss clears it', async () => {
    const { t, pty } = setup();
    const start = await t.app.bus.dispatch(t.sender, 'run.start', { projectId: acme, command: 'pnpm dev' });
    expect(commandResultSchema('run.start').safeParse(start).success).toBe(true);
    if (!start.ok) throw new Error('start failed');
    expect(commands['run.start'].output.safeParse(start.value).success).toBe(true);

    const ops = () => {
      t.app.publisher.flush();
      return t.win
        .batches()
        .flatMap((b) => b.deltas)
        .filter((d) => d.op === 'runs.set') as unknown as { run: { phase: string } | null }[];
    };
    expect(ops().map((d) => d.run?.phase)).toEqual(['starting', 'running']);

    const stop = await t.app.bus.dispatch(t.sender, 'run.stop', { projectId: acme });
    expect(stop).toEqual({ ok: true, value: {} });
    expect(pty.killed).toEqual([start.value.terminalId]);
    expect(ops().at(-1)?.run?.phase).toBe('exited');

    const dismiss = await t.app.bus.dispatch(t.sender, 'run.dismiss', { projectId: acme });
    expect(dismiss).toEqual({ ok: true, value: {} });
    expect(ops().at(-1)?.run).toBeNull();
    expect(t.app.publisher.snapshot().runs).toEqual([]);
  });

  it('rejects malformed input before touching the service', async () => {
    const { t } = setup();
    const r = await t.app.bus.dispatch(t.sender, 'run.start', { projectId: acme, command: '' });
    expect(r.ok).toBe(false);
    expect(t.app.runs.all()).toEqual([]);
  });
});
