import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BrokerServer } from '@styx/broker';
import { resolveRealBinary } from './path-resolve';
import { wrap } from './wrap';

function fakeBin(dir: string, name: string, body: string) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe('shim path resolution', () => {
  it('skips the shim dir and finds the real binary', () => {
    const shim = mkdtempSync(join(tmpdir(), 'styx-shim-'));
    const real = mkdtempSync(join(tmpdir(), 'styx-real-'));
    fakeBin(shim, 'vercel', 'echo shim');
    const r = fakeBin(real, 'vercel', 'echo real');
    expect(resolveRealBinary('vercel', { PATH: `${shim}:${real}`, STYX_SHIM_DIR: shim })).toBe(r);
    expect(resolveRealBinary('nope', { PATH: real })).toBeNull();
  });
});

describe('wrap', () => {
  it('runs the real tool with broker-issued env and reports the exit code', async () => {
    const shim = mkdtempSync(join(tmpdir(), 'styx-shim-'));
    const real = mkdtempSync(join(tmpdir(), 'styx-real-'));
    fakeBin(real, 'vercel', 'test "$VERCEL_TOKEN" = "tok" && exit 5; exit 9');
    const sock = join(mkdtempSync(join(tmpdir(), 'styx-brk-')), 'b.sock');
    const reports: number[] = [];
    const server = new BrokerServer({ authenticate: async () => ({ sessionId: 's1', projectId: 'p', projectName: 'acme', worktreePath: null, branch: null, agent: 'shell' }) });
    server.on('exec_authorize', async (p) => {
      expect(p.tool).toBe('vercel');
      expect(p.argv).toEqual(['deploy', '--prod']);
      return { grantId: 'g', useId: 'u1', env: { VERCEL_TOKEN: 'tok' } };
    });
    server.on('exec_report', async (p) => {
      reports.push(p.exitCode);
      return { ok: true };
    });
    await server.listen(sock);
    const errs: string[] = [];
    const env = { PATH: `${shim}:${real}`, STYX_SHIM_DIR: shim, STYX_BROKER: sock, STYX_SESSION_ID: 's1', STYX_TOKEN: 'x'.repeat(32) };
    const code = await wrap('vercel', ['deploy', '--prod'], { env, stderr: (s) => errs.push(s), spawn });
    expect(code).toBe(5);
    expect(reports).toEqual([5]);
    expect(errs).toEqual([]);
    await server.close();
  });

  it('fails closed when the broker denies', async () => {
    const real = mkdtempSync(join(tmpdir(), 'styx-real-'));
    fakeBin(real, 'gh', 'exit 0');
    const sock = join(mkdtempSync(join(tmpdir(), 'styx-brk-')), 'b.sock');
    const server = new BrokerServer({ authenticate: async () => null });
    await server.listen(sock);
    const errs: string[] = [];
    const code = await wrap('gh', ['pr', 'create'], { env: { PATH: real, STYX_BROKER: sock, STYX_SESSION_ID: 's1', STYX_TOKEN: 'x'.repeat(32) }, stderr: (s) => errs.push(s) });
    expect(code).toBe(77);
    expect(errs[0]).toMatch(/not granted/);
    await server.close();
  });

  it('runs the tool plainly outside a Styx session', async () => {
    const real = mkdtempSync(join(tmpdir(), 'styx-real-'));
    fakeBin(real, 'aws', 'exit 3');
    expect(await wrap('aws', [], { env: { PATH: real }, stderr: () => {} })).toBe(3);
    expect(await wrap('missing', [], { env: { PATH: real }, stderr: () => {} })).toBe(127);
  });
});
