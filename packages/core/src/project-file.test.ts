import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from './model/settings';
import {
  MACHINE_PROJECT_SETTINGS,
  PROJECT_FILE_SCHEMA_URL,
  isMachineProjectSetting,
  machineProjectSettings,
  mergeSettings,
  parseProjectFile,
  projectSettingsFromFile,
  serializeProjectFile,
  settingsAfterFileRead,
  targetNameSchema,
} from './project-file';
import { commands } from './ipc/contract';
import type { ProjectFileV1 } from './project-file';

const SAMPLE: ProjectFileV1 = {
  version: 1,
  name: 'acme-shop',
  targets: [
    {
      name: 'Vercel',
      provider: 'vercel',
      env: 'prod',
      authMethod: 'oauth',
      config: { teamSlug: 'acme', project: 'shop' },
      policy: 'ask-mfa',
    },
    {
      name: 'AWS acme-prod',
      provider: 'aws',
      env: 'prod',
      authMethod: 'key',
      config: { region: 'us-east-1', roleArn: 'arn:aws:iam::123:role/styx-agent' },
    },
    {
      name: 'GitHub acme/shop',
      provider: 'github',
      env: 'scm',
      authMethod: 'oauth',
      config: { owner: 'acme', repo: 'shop' },
      policy: 'always',
    },
  ],
  agents: {
    default: 'claude',
    model: null,
    autoApproveEdits: false,
    mayRequestTargets: true,
    notifyWhenNeedsMe: true,
    perAgent: {},
  },
  policies: { disabledBuiltins: [], extra: [] },
  worktrees: { baseBranch: 'main', branchPrefix: 'agent/', location: 'sibling' },
  shell: { windows: 'powershell' },
  lineEndings: 'auto',
  env: { files: ['.env.local'], shareWithAgents: 'per-grant' },
};

describe('parseProjectFile', () => {
  it('parses the plan §4 example', () => {
    const r = parseProjectFile(JSON.stringify({ $schema: PROJECT_FILE_SCHEMA_URL, ...SAMPLE }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file.targets?.[0]?.policy).toBe('ask-mfa');
  });
  it('accepts authMethod cli (the provider CLI holds the login; nothing secret in the file)', () => {
    const r = parseProjectFile(
      '{"version":1,"name":"x","targets":[{"name":"GCP","provider":"gcp","env":"prod","authMethod":"cli","config":{"projectId":"acme-shop","account":"nic@acme.dev"}}]}',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file.targets?.[0]?.authMethod).toBe('cli');
  });

  it('rejects invalid JSON, wrong schema and newer versions', () => {
    expect(parseProjectFile('{')).toMatchObject({ ok: false, error: { code: 'invalid-json' } });
    expect(parseProjectFile('{"version":1}')).toMatchObject({ ok: false, error: { code: 'invalid-schema' } });
    expect(parseProjectFile('{"version":2,"name":"x"}')).toMatchObject({
      ok: false,
      error: { code: 'newer-version' },
    });
    expect(parseProjectFile('[]')).toMatchObject({ ok: false, error: { code: 'invalid-schema' } });
    expect(
      parseProjectFile(
        '{"version":1,"name":"x","targets":[{"name":"a","provider":"nope","env":"prod","authMethod":"key"}]}',
      ),
    ).toMatchObject({ ok: false });
  });
  it('rejects secret-looking keys anywhere (the file is committed)', () => {
    const r = parseProjectFile(
      JSON.stringify({
        ...SAMPLE,
        targets: [{ ...SAMPLE.targets?.[1], config: { region: 'x', secretAccessKey: 'AKIA' } }],
      }),
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid-schema' } });
    if (!r.ok) expect(r.error.message).toContain('targets.0.config.secretAccessKey');
    expect(parseProjectFile(JSON.stringify({ ...SAMPLE, env: { files: [], tokens: ['x'] } })).ok).toBe(false);
    expect(parseProjectFile(JSON.stringify({ ...SAMPLE, extra: [{ apiToken: 'x' }] })).ok).toBe(false);
  });
  it('allows credentialRef (a keychain reference, not a secret)', () => {
    expect(parseProjectFile(JSON.stringify({ ...SAMPLE, credentialRef: 'styx:v1:x' })).ok).toBe(true);
  });
});

describe('serializeProjectFile', () => {
  it('round-trips with stable key order and preserves unknown keys', () => {
    const withUnknown = {
      ...SAMPLE,
      zeta: { future: true },
      targets: [
        {
          ...(SAMPLE.targets?.[0] as NonNullable<ProjectFileV1['targets']>[number]),
          policy: 'ask-mfa' as const,
          custom: 1,
        },
      ],
    };
    const text = serializeProjectFile(withUnknown as ProjectFileV1);
    const parsed = parseProjectFile(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeProjectFile(parsed.file)).toBe(text);
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual([
      '$schema',
      'version',
      'name',
      'targets',
      'agents',
      'policies',
      'worktrees',
      'shell',
      'lineEndings',
      'env',
      'zeta',
    ]);
    expect(
      Object.keys((JSON.parse(text) as { targets: Record<string, unknown>[] }).targets[0] ?? {}),
    ).toEqual(['name', 'provider', 'env', 'authMethod', 'config', 'policy', 'custom']);
    expect(text.endsWith('\n')).toBe(true);
    expect((JSON.parse(text) as { zeta: unknown }).zeta).toEqual({ future: true });
  });
  it('a file without targets serializes without a targets key', () => {
    expect(JSON.parse(serializeProjectFile({ version: 1, name: 'x' }))).toEqual({
      $schema: PROJECT_FILE_SCHEMA_URL,
      version: 1,
      name: 'x',
    });
  });
});

describe('mergeSettings', () => {
  it('tags each key with its source: default ← app ← project', () => {
    const eff = mergeSettings(
      DEFAULT_PROJECT_SETTINGS,
      { defaultAgent: 'codex', shellWindows: 'wsl' },
      { version: 1, name: 'x', agents: { default: 'gemini' }, lineEndings: 'lf' },
    );
    expect(eff.defaultAgent).toEqual({ value: 'gemini', source: 'project' });
    expect(eff.shellWindows).toEqual({ value: 'wsl', source: 'app' });
    expect(eff.lineEndings).toEqual({ value: 'lf', source: 'project' });
    expect(eff.branchPrefix).toEqual({ value: 'agent/', source: 'default' });
    expect(Object.keys(eff)).toEqual(Object.keys(DEFAULT_PROJECT_SETTINGS));
  });
  it('accepts a null file or an already-flattened partial', () => {
    expect(mergeSettings(DEFAULT_PROJECT_SETTINGS, {}, null).model).toEqual({
      value: null,
      source: 'default',
    });
    expect(mergeSettings(DEFAULT_PROJECT_SETTINGS, {}, { model: 'opus' }).model).toEqual({
      value: 'opus',
      source: 'project',
    });
  });
  it('projectSettingsFromFile takes dev.platform, and dev.device / dev.appId only as plain identifiers', () => {
    const file = {
      version: 1 as const,
      name: 'x',
      dev: { platform: 'ios' as const, device: 'iPhone 17 Pro', appId: 'com.acme.shop' },
    };
    expect(projectSettingsFromFile(file)).toEqual({
      devPlatform: 'ios',
      devDevice: 'iPhone 17 Pro',
      devAppId: 'com.acme.shop',
    });
    expect(
      projectSettingsFromFile({
        ...file,
        dev: { platform: 'android', device: 'Pixel; rm -rf /', appId: 'x y' },
      }),
    ).toEqual({ devPlatform: 'android' });
  });

  it('projectSettingsFromFile takes checks.command trimmed; a blank one is "not known yet" (issue #2)', () => {
    const file = { version: 1 as const, name: 'x' };
    expect(
      projectSettingsFromFile({ ...file, checks: { command: ' pnpm typecheck && pnpm test ' } }),
    ).toEqual({ checksCommand: 'pnpm typecheck && pnpm test' });
    expect(projectSettingsFromFile({ ...file, checks: { command: '  ' } })).toEqual({});
    expect(projectSettingsFromFile({ ...file, checks: {} })).toEqual({});
    const parsed = parseProjectFile('{"version":1,"name":"x","checks":{"command":"make check"}}');
    expect(parsed.ok && parsed.file.checks).toEqual({ command: 'make check' });
  });

  it('projectSettingsFromFile extracts only the keys the file sets', () => {
    expect(projectSettingsFromFile({ version: 1, name: 'x' })).toEqual({});
    expect(projectSettingsFromFile(SAMPLE)).toEqual({
      defaultAgent: 'claude',
      model: null,
      autoApproveEdits: false,
      mayRequestTargets: true,
      notifyWhenNeedsMe: true,
      baseBranch: 'main',
      branchPrefix: 'agent/',
      worktreeLocation: 'sibling',
      shellWindows: 'powershell',
      lineEndings: 'auto',
      envFiles: ['.env.local'],
      envShareWithAgents: 'per-grant',
    });
  });
});

describe('where project settings live (issue #10)', () => {
  const MACHINE: Partial<ProjectSettings> = {
    syncOnSpawn: false,
    syncBeforePublish: false,
    autoSync: 'off',
    hotspots: ['pnpm-lock.yaml'],
    integration: 'review',
    autoLand: true,
  };

  it('the machine-only keys are exactly the lane upkeep settings', () => {
    expect([...MACHINE_PROJECT_SETTINGS].sort()).toEqual(Object.keys(MACHINE).sort());
    for (const k of MACHINE_PROJECT_SETTINGS) expect(k in DEFAULT_PROJECT_SETTINGS).toBe(true);
  });

  it.each([
    ['syncOnSpawn', true],
    ['autoLand', true],
    ['hotspots', true],
    ['baseBranch', false],
    ['checksCommand', false],
    ['devCommand', false],
    ['defaultAgent', false],
    ['notAKey', false],
  ] as const)('isMachineProjectSetting(%s) = %s', (key, expected) => {
    expect(isMachineProjectSetting(key)).toBe(expected);
  });

  it('machineProjectSettings keeps only the machine keys that are set', () => {
    expect(machineProjectSettings({})).toEqual({});
    expect(machineProjectSettings({ ...MACHINE, baseBranch: 'dev', checksCommand: 'make check' })).toEqual(
      MACHINE,
    );
    expect(machineProjectSettings({ autoLand: false, devCommand: 'pnpm dev' })).toEqual({ autoLand: false });
  });

  const handEdited: ProjectFileV1 = {
    version: 1,
    name: 'x',
    worktrees: { baseBranch: 'develop' },
    checks: { command: 'make check' },
    dev: { command: 'pnpm dev' },
  };

  it.each<[string, Partial<ProjectSettings>, ProjectFileV1 | null, Partial<ProjectSettings>]>([
    ['nothing stored, empty file', {}, { version: 1, name: 'x' }, {}],
    [
      'machine keys survive a re-read of a file that sets nothing',
      MACHINE,
      { version: 1, name: 'x' },
      MACHINE,
    ],
    [
      'machine keys survive; the file decides its own keys',
      { ...MACHINE, baseBranch: 'main', checksCommand: 'pnpm test' },
      handEdited,
      { ...MACHINE, baseBranch: 'develop', checksCommand: 'make check', devCommand: 'pnpm dev' },
    ],
    [
      'a file key the file no longer sets falls back to the default (the file is its source)',
      { baseBranch: 'main', devCommand: 'pnpm start', autoLand: true },
      { version: 1, name: 'x', dev: { command: 'pnpm dev' } },
      { devCommand: 'pnpm dev', autoLand: true },
    ],
    [
      'the file cannot set a machine key (it has no field for one)',
      { autoSync: 'publish' },
      {
        version: 1,
        name: 'x',
        worktrees: { baseBranch: 'main', autoLand: true } as ProjectFileV1['worktrees'],
      },
      { baseBranch: 'main', autoSync: 'publish' },
    ],
    ['the file is gone: only the machine keys stay', { ...MACHINE, baseBranch: 'develop' }, null, MACHINE],
  ])('settingsAfterFileRead: %s', (_name, stored, file, expected) => {
    expect(settingsAfterFileRead(stored, file)).toEqual(expected);
  });
});

describe('target names', () => {
  it('M4: are limited to a plain charset in project.json and connect inputs', () => {
    for (const ok of ['Vercel', 'AWS acme-prod', 'GitHub acme/shop', 'db@prod:5432', 'a+b_c.d'])
      expect(targetNameSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['', 'x; rm -rf /', 'a"b', "a'b", 'a$(id)', 'a`b', 'a\nb', 'x'.repeat(81), 'ünïcode'])
      expect(targetNameSchema.safeParse(bad).success).toBe(false);
    const r = parseProjectFile(
      JSON.stringify({
        version: 1,
        name: 'x',
        targets: [{ name: 'x; rm', provider: 'vercel', env: 'prod', authMethod: 'oauth' }],
      }),
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'invalid-schema', message: expect.stringContaining('target name') },
    });
    const ssh = commands['target.connect.saveSsh'].input.safeParse({
      projectId: 'p',
      name: 'host"; calc',
      env: 'prod',
      host: 'h',
      user: 'u',
      keyPath: '/k',
    });
    expect(ssh.success).toBe(false);
    expect(
      commands['target.connect.saveKey'].input.safeParse({
        projectId: 'p',
        provider: 'aws',
        name: 'a$(id)',
        env: 'prod',
        accessKey: 'a',
        secret: 's',
      }).success,
    ).toBe(false);
    expect(
      commands['target.connect.start'].input.safeParse({
        projectId: 'p',
        provider: 'aws',
        env: 'prod',
        name: 'AWS acme-prod',
      }).success,
    ).toBe(true);
  });
});
