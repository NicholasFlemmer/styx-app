import { describe, expect, it } from 'vitest';
import { redact, redactArgv } from './logger';

describe('redact', () => {
  it('masks secret-named keys and secret-shaped strings', () => {
    const out = redact({ token: 'abc', nested: { accessKey: 'AKIAABCDEFGHIJKLMNOP', ok: 'fine' }, list: ['ghp_' + 'a'.repeat(36)] });
    expect(out).toEqual({ token: '[redacted]', nested: { accessKey: '[redacted]', ok: 'fine' }, list: ['[redacted]'] });
  });
});

describe('redactArgv', () => {
  it('drops values after secret flags, masks secret key=value pairs, and scrubs secret shapes (M1)', () => {
    expect(redactArgv(['--token', 'vt-secret-123', 'deploy', '--prod'])).toEqual(['--token', '[redacted]', 'deploy', '--prod']);
    expect(redactArgv(['login', '--with-token', 'abc'])).toEqual(['login', '--with-token', '[redacted]']);
    expect(redactArgv(['-p', 'hunter2', 'user@host'])).toEqual(['-p', '[redacted]', 'user@host']);
    expect(redactArgv(['--password=hunter2', '--api-key=k', '--secret-key=s', '--name=ok'])).toEqual([
      '--password=[redacted]',
      '--api-key=[redacted]',
      '--secret-key=[redacted]',
      '--name=ok',
    ]);
    expect(redactArgv(['env', 'add', 'X', `ghp_${'a'.repeat(36)}`])).toEqual(['env', 'add', 'X', '[redacted]']);
    expect(redactArgv(['--token'])).toEqual(['--token']);
  });
});
