import { describe, expect, it, vi } from 'vitest';
import log from 'electron-log/main';
import { commandCarriesSecret, logger, redact, redactArgv } from './logger';

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('redact', () => {
  it('masks secret-named keys and secret-shaped strings', () => {
    const out = redact({
      token: 'abc',
      nested: { accessKey: 'AKIAABCDEFGHIJKLMNOP', ok: 'fine' },
      list: ['ghp_' + 'a'.repeat(36)],
    });
    expect(out).toEqual({
      token: '[redacted]',
      nested: { accessKey: '[redacted]', ok: 'fine' },
      list: ['[redacted]'],
    });
  });
});

describe('redactArgv', () => {
  it('drops values after secret flags, masks secret key=value pairs, and scrubs secret shapes (M1)', () => {
    expect(redactArgv(['--token', 'vt-secret-123', 'deploy', '--prod'])).toEqual([
      '--token',
      '[redacted]',
      'deploy',
      '--prod',
    ]);
    expect(redactArgv(['login', '--with-token', 'abc'])).toEqual(['login', '--with-token', '[redacted]']);
    expect(redactArgv(['-p', 'hunter2', 'user@host'])).toEqual(['-p', '[redacted]', 'user@host']);
    // `-p` before a bare port number is a port (ssh, next dev, vite), not a password.
    expect(redactArgv(['ssh', '-p', '2222', 'user@host'])).toEqual(['ssh', '-p', '2222', 'user@host']);
    expect(redactArgv(['npm', 'run', 'dev', '--', '-p', '3010'])).toEqual([
      'npm',
      'run',
      'dev',
      '--',
      '-p',
      '3010',
    ]);
    expect(redactArgv(['-p', '123456'])).toEqual(['-p', '[redacted]']);
    expect(redactArgv(['--password=hunter2', '--api-key=k', '--secret-key=s', '--name=ok'])).toEqual([
      '--password=[redacted]',
      '--api-key=[redacted]',
      '--secret-key=[redacted]',
      '--name=ok',
    ]);
    expect(redactArgv(['env', 'add', 'X', `ghp_${'a'.repeat(36)}`])).toEqual([
      'env',
      'add',
      'X',
      '[redacted]',
    ]);
    expect(redactArgv(['--token'])).toEqual(['--token']);
    // Bare secret words, env-style KEY=value, secret payload flags, and more token shapes.
    expect(redactArgv(['configure', 'set', 'aws_secret_access_key', 'wJalrXUt'])).toEqual([
      'configure',
      'set',
      'aws_secret_access_key',
      '[redacted]',
    ]);
    expect(redactArgv(['AWS_SECRET_ACCESS_KEY=wJalrXUt', 'GH_TOKEN=x', 'REGION=eu'])).toEqual([
      'AWS_SECRET_ACCESS_KEY=[redacted]',
      'GH_TOKEN=[redacted]',
      'REGION=eu',
    ]);
    expect(redactArgv(['secret', 'set', 'NPM', '--body', 'npm_abc'])).toEqual([
      'secret',
      'set',
      'NPM',
      '--body',
      '[redacted]',
    ]);
    expect(redactArgv(['secret', 'set', 'NPM', '-b', 'npm_abc'])).toEqual([
      'secret',
      'set',
      'NPM',
      '-b',
      '[redacted]',
    ]);
    expect(redactArgv(['env', 'add', 'K', '--value=npm_abc'])).toEqual([
      'env',
      'add',
      'K',
      '--value=[redacted]',
    ]);
    expect(
      redact(
        `login sbp_${'a'.repeat(40)} sk_live_${'b'.repeat(24)} sk_test_${'c'.repeat(24)} gho_${'d'.repeat(36)} xoxa-1-2`,
      ),
    ).toBe('login [redacted] [redacted] [redacted] [redacted] [redacted]');
    expect(redact(`eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`)).toBe('[redacted]');
  });

  it('masks *_KEY / API_KEY env assignments and connection strings with credentials', () => {
    expect(redactArgv(['API_KEY=abc123', 'OPENAI_API_KEY=sk-x', 'STRIPE_KEY=y', 'pnpm', 'dev'])).toEqual([
      'API_KEY=[redacted]',
      'OPENAI_API_KEY=[redacted]',
      'STRIPE_KEY=[redacted]',
      'pnpm',
      'dev',
    ]);
    expect(redactArgv(['DATABASE_URL=postgres://postgres:hunter2@localhost/db', 'pnpm', 'dev'])).toEqual([
      'DATABASE_URL=[redacted]',
      'pnpm',
      'dev',
    ]);
    expect(redactArgv(['--db-url', 'postgresql://postgres:hunter2@db.example:5432/app'])).toEqual([
      '--db-url',
      '[redacted]',
    ]);
    expect(redactArgv(['--set-env-vars=DB_PASSWORD=hunter2'])).toEqual(['--set-env-vars=[redacted]']);
    // A plain URL, a keyed name that is not a key, and a monorepo filter stay.
    expect(redactArgv(['http://localhost:3000', 'KEYBOARD=1', '--filter', 'web'])).toEqual([
      'http://localhost:3000',
      'KEYBOARD=1',
      '--filter',
      'web',
    ]);
  });
});

describe('redact: Fly.io and Render token shapes (issues #23, #25)', () => {
  // Assembled at run time so no literal token shape sits in the repo.
  const fly = ['FlyV1 fm2', '_', 'a'.repeat(40), ',fm2_', 'b'.repeat(30)].join('');
  const flyOld = ['fo1', '_', 'c'.repeat(43)].join('');
  const render = ['rnd', '_', 'd'.repeat(32)].join('');
  it.each([
    ['a Fly.io macaroon bundle', `FLY_API_TOKEN=x fly deploy -t ${fly}`],
    ['an older Fly.io personal token', `token ${flyOld} here`],
    ['a Render API key', `curl -H "Authorization: Bearer ${render}"`],
  ])('%s', (_name, text) => {
    const out = redact(text);
    expect(out).toContain('[redacted]');
    expect(out).not.toMatch(/fm2_|fo1_|rnd_/);
  });
  it.each([
    ['fly secrets set', ['secrets', 'set', 'SIGNING_SALT=hunter2', 'APP_MODE=x'], undefined],
    ['fly secrets import', ['secrets', 'import', 'SALT=hunter2'], undefined],
    ['railway variables --set', ['variables', '--set', 'SESSION_SALT=hunter2'], undefined],
    ['railway variables --set=', ['variables', '--set=SESSION_SALT=hunter2'], undefined],
    ['railway variable set', ['variable', 'set', 'SALT=hunter2'], undefined],
    ['fly -t <opaque token>', ['deploy', '-t', 'hunter2'], 'fly'],
    ['fly secrets with a flag before set', ['secrets', '-a', 'app', 'set', 'SALT=hunter2'], undefined],
    ['railway variable --json set', ['variable', '--json', 'set', 'SALT=hunter2'], 'railway'],
    ['fly deploy --build-secret', ['deploy', '--build-secret', 'NPM_SALT=hunter2'], 'fly'],
    ['railway add -v', ['add', '-s', 'web', '-v', 'SALT=hunter2'], 'railway'],
  ] as const)('masks every value a %s command sets', (_name, argv, tool) => {
    const out = redactArgv([...argv], tool);
    expect(out.join(' ')).not.toContain('hunter2');
    expect(out.join(' ')).not.toMatch(/=x\b/);
  });
  it('keeps names, and leaves ordinary K=V and ssh -t alone', () => {
    expect(redactArgv(['secrets', 'set', 'SALT=hunter2'])).toEqual(['secrets', 'set', 'SALT=[redacted]']);
    expect(redactArgv(['deploy', '--env', 'MODE=fast'])).toEqual(['deploy', '--env', 'MODE=fast']);
    expect(redactArgv(['-t', 'deploy@host'], 'ssh')).toEqual(['-t', 'deploy@host']);
    expect(redactArgv(['upgrade', 'web', '--set', 'image.tag=1'], 'helm')).toEqual([
      'upgrade',
      'web',
      '--set',
      'image.tag=1',
    ]);
  });
  it('drops the value after --access-token', () => {
    expect(redactArgv(['deploy', '--access-token', 'opaque-value'])).toEqual([
      'deploy',
      '--access-token',
      '[redacted]',
    ]);
    expect(redactArgv(['deploy', '--access-token=opaque-value'])).not.toContain('opaque-value');
  });
});

describe('commandCarriesSecret', () => {
  it('is token-based: spacing never counts, anything redactArgv masks does', () => {
    expect(commandCarriesSecret('pnpm  dev')).toBe(false);
    expect(commandCarriesSecret('FOO=1\tpnpm dev')).toBe(false);
    expect(commandCarriesSecret('gcloud run deploy api --source . --region europe-west1')).toBe(false);
    expect(commandCarriesSecret('npm --prefix web run dev -- -p 3010')).toBe(false);
    expect(commandCarriesSecret('mysql -p hunter2 -e "select 1"')).toBe(true);
    expect(commandCarriesSecret('pnpm dev --token abc123')).toBe(true);
    expect(commandCarriesSecret('API_KEY=abc pnpm dev')).toBe(true);
    expect(commandCarriesSecret('DATABASE_URL=postgres://u:p@localhost/db pnpm dev')).toBe(true);
    expect(commandCarriesSecret(`vercel deploy --prod --token ghp_${'a'.repeat(36)}`)).toBe(true);
  });
});

describe('logger', () => {
  it('L-b: redacts the message as well as the meta on every level', () => {
    const ghp = `ghp_${'a'.repeat(36)}`;
    logger.info(`token ${ghp} rejected`, { token: 'x', ok: 'fine' });
    logger.warn(`AKIAABCDEFGHIJKLMNOP failed`);
    logger.error(`key ${ghp}`, { nested: { password: 'p' } });
    logger.debug(`sbp_${'b'.repeat(24)}`, ['gho_' + 'c'.repeat(36)]);
    expect(vi.mocked(log.info)).toHaveBeenCalledWith('token [redacted] rejected', {
      token: '[redacted]',
      ok: 'fine',
    });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith('[redacted] failed', '');
    expect(vi.mocked(log.error)).toHaveBeenCalledWith('key [redacted]', {
      nested: { password: '[redacted]' },
    });
    expect(vi.mocked(log.debug)).toHaveBeenCalledWith('[redacted]', ['[redacted]']);
  });
});

describe('publish guards', () => {
  it('isSecretFile: env, keys, credential stores; not examples or ordinary files', async () => {
    const { isSecretFile } = await import('./logger');
    for (const f of [
      '.env',
      'apps/web/.env.local',
      'deploy.pem',
      'k/id_rsa',
      'id_ed25519.pub',
      '.npmrc',
      'gcp/credentials.json',
      'x.p12',
    ])
      expect(isSecretFile(f), f).toBe(true);
    for (const f of ['.env.example', '.env.sample', 'src/env.ts', 'README.md', 'keys.md', 'monkey.pemx'])
      expect(isSecretFile(f), f).toBe(false);
  });

  it('redactPatch: masks secret assignments and credential URLs on diff lines, keeps the rest', async () => {
    const { redactPatch } = await import('./logger');
    const patch = [
      '+API_KEY=abc123',
      '+export DATABASE_URL=postgres://u:p@h/db',
      '-  password: hunter2',
      '+const port = 3000',
      `+token: ghp_${'a'.repeat(36)}`,
    ].join('\n');
    const out = redactPatch(patch);
    expect(out).toContain('+API_KEY=[redacted]');
    expect(out).toContain('+export DATABASE_URL=[redacted]');
    expect(out).toContain('-  password=[redacted]');
    expect(out).toContain('+const port = 3000');
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('hunter2');
  });
});
