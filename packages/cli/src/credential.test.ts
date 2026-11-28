import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { BrokerServer } from '@styx/broker';
import { describe, expect, it } from 'vitest';
import { credential } from './credential';

const input = 'protocol=https\nhost=github.com\npath=Acme/Shop.git\n\n';
function io(raw = input, env: NodeJS.ProcessEnv = {}) {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    env,
    stdin: Readable.from([raw]),
    stdout: (s: string) => output.push(s),
    stderr: (s: string) => errors.push(s),
  };
}

describe('Git credential helper', () => {
  it.each(['fetch', 'push', undefined])(
    'obtains a broker credential with operation %s',
    async (operation) => {
      const dir = mkdtempSync(join(tmpdir(), 'styx-credential-'));
      const endpoint =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\styx-credential-${randomUUID()}`
          : join(dir, 'broker.sock');
      const server = new BrokerServer({
        authenticate: async () => ({
          sessionId: 's',
          projectId: 'p',
          projectName: 'shop',
          worktreePath: null,
          branch: null,
          agent: 'shell',
        }),
      });
      server.on('exec_authorize', async (request) => {
        expect(request.tool).toBe('git-credential-styx');
        expect(request.argv).toEqual([
          'get',
          operation === 'fetch' ? 'fetch' : 'push',
          'https://github.com/acme/shop.git',
        ]);
        return { grantId: 'grant', useId: 'use', env: { GH_TOKEN: 'synthetic-token' } };
      });
      server.on('exec_report', async (request) => {
        expect(request).toEqual({ useId: 'use', exitCode: 0 });
        return { ok: true };
      });
      await server.listen(endpoint);
      const test = io(operation === 'fetch' ? input.replace('github.com', 'GitHub.COM') : input, {
        STYX_BROKER: endpoint,
        STYX_SESSION_ID: 's',
        STYX_TOKEN: 'x'.repeat(32),
        ...(operation ? { STYX_GIT_OPERATION: operation } : {}),
      });
      try {
        expect(await credential('get', test)).toBe(0);
        expect(test.output.join('')).toBe('username=x-access-token\npassword=synthetic-token\n\n');
        expect(test.errors).toEqual([]);
      } finally {
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it.each([
    input.replace('https', 'http'),
    input.replace('github.com', 'github.com:443'),
    input.replace('Acme/Shop.git', 'Acme/../Shop'),
    input.replace('host=github.com', 'host=github.com\nhost=evil.example'),
    input.replace('path=', 'url=https://evil.example\npath='),
    'x'.repeat(16_385),
  ])('refuses malformed requests without delivering a credential', async (raw) => {
    const test = io(raw);
    expect(await credential('get', test)).toBe(1);
    expect(test.output.join('')).toBe('quit=true\n\n');
    expect(test.errors.join('')).not.toContain(raw);
  });
  it('stops Git fallback when the broker is unavailable', async () => {
    const test = io();
    expect(await credential('get', test)).toBe(1);
    expect(test.output.join('')).toBe('quit=true\n\n');
  });
  it.each(['store', 'erase'])('does not persist or return credentials for %s', async (action) => {
    const test = io('password=synthetic-token\n');
    expect(await credential(action, test)).toBe(0);
    expect(test.output).toEqual([]);
  });
});
