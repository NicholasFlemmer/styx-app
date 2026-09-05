import { describe, expect, it, vi } from 'vitest';
import log from 'electron-log/main';
import { logger, redact, redactArgv } from './logger';

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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
    // Bare secret words, env-style KEY=value, secret payload flags, and more token shapes.
    expect(redactArgv(['configure', 'set', 'aws_secret_access_key', 'wJalrXUt'])).toEqual(['configure', 'set', 'aws_secret_access_key', '[redacted]']);
    expect(redactArgv(['AWS_SECRET_ACCESS_KEY=wJalrXUt', 'GH_TOKEN=x', 'REGION=eu'])).toEqual(['AWS_SECRET_ACCESS_KEY=[redacted]', 'GH_TOKEN=[redacted]', 'REGION=eu']);
    expect(redactArgv(['secret', 'set', 'NPM', '--body', 'npm_abc'])).toEqual(['secret', 'set', 'NPM', '--body', '[redacted]']);
    expect(redactArgv(['secret', 'set', 'NPM', '-b', 'npm_abc'])).toEqual(['secret', 'set', 'NPM', '-b', '[redacted]']);
    expect(redactArgv(['env', 'add', 'K', '--value=npm_abc'])).toEqual(['env', 'add', 'K', '--value=[redacted]']);
    expect(redact(`login sbp_${'a'.repeat(40)} sk_live_${'b'.repeat(24)} sk_test_${'c'.repeat(24)} gho_${'d'.repeat(36)} xoxa-1-2`)).toBe('login [redacted] [redacted] [redacted] [redacted] [redacted]');
    expect(redact(`eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`)).toBe('[redacted]');
  });
});

describe('logger', () => {
  it('L-b: redacts the message as well as the meta on every level', () => {
    const ghp = `ghp_${'a'.repeat(36)}`;
    logger.info(`token ${ghp} rejected`, { token: 'x', ok: 'fine' });
    logger.warn(`AKIAABCDEFGHIJKLMNOP failed`);
    logger.error(`key ${ghp}`, { nested: { password: 'p' } });
    logger.debug(`sbp_${'b'.repeat(24)}`, ['gho_' + 'c'.repeat(36)]);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith('token [redacted] rejected', { token: '[redacted]', ok: 'fine' });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith('[redacted] failed', '');
    expect(vi.mocked(log.error)).toHaveBeenCalledWith('key [redacted]', { nested: { password: '[redacted]' } });
    expect(vi.mocked(log.debug)).toHaveBeenCalledWith('[redacted]', ['[redacted]']);
  });
});
