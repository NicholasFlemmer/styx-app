import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DetectService, type DetectDeps } from '../../services/detect-service';
import { makeTestApp } from '../../test-support';
import { cliBinaryKey } from './ide';

const fakeDetect = (home: string) =>
  new DetectService({
    platform: 'darwin',
    home,
    pathEnv: '', // nothing on PATH: only a located binary can make an agent `found`
    env: { SHELL: '/bin/sh' },
    exec: async (bin, args) => {
      if (args[0] === '--version')
        return { stdout: bin.includes('codex') ? 'codex-cli 0.42.0' : 'sh 3.2', exitCode: 0 };
      if (args[0] === '--help') return { stdout: 'usage: --config <f> -c', exitCode: 0 };
      return { stdout: '', exitCode: 0 };
    },
  } satisfies DetectDeps);

describe('detect.setBinary (Locate binary)', () => {
  it('probes the picked path, stores it in cli_installs + app_settings, and survives a re-detect until the file goes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'styx-home-'));
    const bin = join(home, 'codex');
    writeFileSync(bin, '#!/bin/sh\necho 0.42.0\n');
    chmodSync(bin, 0o755);
    const t = makeTestApp({ fixture: 'empty', detect: fakeDetect(home) });
    const { app, sender } = t;

    const missing = await app.bus.dispatch(sender, 'detect.setBinary', {
      agent: 'codex',
      path: join(home, 'nope'),
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(await app.bus.dispatch(sender, 'detect.setBinary', { agent: 'shell', path: bin })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });

    const r = await app.bus.dispatch(sender, 'detect.setBinary', { agent: 'codex', path: bin });
    expect(r).toMatchObject({
      ok: true,
      value: {
        cli: {
          agent: 'codex',
          binary: bin,
          version: '0.42.0',
          found: true,
          capabilities: { configOverride: true },
        },
      },
    });
    expect(app.repos.discovery.cli('codex')?.binary).toBe(bin);
    expect(app.repos.settings.kv.get<string>(cliBinaryKey('codex'))).toBe(bin);
    app.publisher.flush();
    expect(
      t.win
        .batches()
        .at(-1)
        ?.deltas.some((d) => d.op === 'discovery.set'),
    ).toBe(true);

    // PATH detection finds nothing, but the located binary keeps codex `found`.
    const again = await app.bus.dispatch(sender, 'detect.clis', {});
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value.clis.find((c) => c.agent === 'codex')).toMatchObject({ binary: bin, found: true });
    expect(again.value.clis.find((c) => c.agent === 'claude')).toMatchObject({ binary: null, found: false });

    // Once the file disappears the override is dropped and detection is honest again.
    rmSync(bin);
    const gone = await app.bus.dispatch(sender, 'detect.clis', {});
    if (!gone.ok) throw new Error(gone.error.message);
    expect(gone.value.clis.find((c) => c.agent === 'codex')).toMatchObject({ binary: null, found: false });
    expect(app.repos.settings.kv.get<string>(cliBinaryKey('codex'))).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });
});
