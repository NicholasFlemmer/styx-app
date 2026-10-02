import { describe, expect, it } from 'vitest';
import { FakeCliRunner } from '../providers/cli-runner';
import { detectDeployCommands, type DeployDetectDeps } from './deploy-detect';

/** A fake repo: `files` are the paths that exist (relative to /repo), `dirs` list directory contents. */
const fakeFs = (
  files: string[],
  dirs: Record<string, string[]> = {},
  texts: Record<string, string> = {},
  root = '/repo',
) => {
  const all = new Set([...files.map((f) => `${root}/${f}`), ...Object.keys(dirs).map((d) => `${root}/${d}`)]);
  // The detector builds paths with `join`, which uses `\\` on a Windows host; the fake speaks `/`.
  const n = (p: string) => p.replace(/\\/g, '/');
  const deps: Omit<DeployDetectDeps, 'cli'> = {
    exists: (p) => all.has(n(p)),
    readDir: (p) => dirs[n(p).replace(`${root}/`, '')] ?? [],
    readText: (p) => texts[n(p).replace(`${root}/`, '')] ?? null,
  };
  return deps;
};
const gcp = (config: Record<string, string> = { projectId: 'acme-prod' }) => ({
  provider: 'gcp' as const,
  config,
});

describe('detectDeployCommands', () => {
  it('vercel is built in: nothing to suggest', async () => {
    expect(
      await detectDeployCommands(
        { provider: 'vercel' as const, config: {} as Record<string, string> },
        '/repo',
        {
          cli: new FakeCliRunner(),
          ...fakeFs(['package.json']),
        },
      ),
    ).toEqual([]);
  });

  it('gcp: App Engine, Firebase and Cloud Build markers come first, each with the target project', async () => {
    const cli = new FakeCliRunner();
    const r = await detectDeployCommands(gcp(), '/repo', {
      cli,
      ...fakeFs(['app.yaml', 'firebase.json', 'cloudbuild.yaml']),
    });
    expect(r.map((s) => s.command)).toEqual([
      'gcloud app deploy --quiet --project acme-prod',
      'firebase deploy --project acme-prod',
      'gcloud builds submit --config cloudbuild.yaml --project acme-prod',
    ]);
    expect(r.map((s) => s.source)).toEqual(['app.yaml', 'firebase.json', 'cloudbuild.yaml']);
    expect(cli.calls).toEqual([]); // no service listing without a Cloud Run marker
  });

  it('gcp Cloud Run: the service matching the folder name gives name and region; otherwise the folder name and the one region in use', async () => {
    const list = JSON.stringify([
      { metadata: { name: 'acme-api', labels: { 'cloud.googleapis.com/location': 'europe-west1' } } },
      { metadata: { name: 'acme-web', labels: { 'cloud.googleapis.com/location': 'europe-west1' } } },
    ]);
    const cli = new FakeCliRunner()
      .install('gcloud')
      .on('gcloud', ['run', 'services', 'list'], { exitCode: 0, stdout: list });
    const matched = await detectDeployCommands(gcp(), '/Users/nic/acme-web', {
      cli,
      ...fakeFs(['Dockerfile'], {}, {}, '/Users/nic/acme-web'),
    });
    expect(matched).toEqual([
      {
        command: 'gcloud run deploy acme-web --source . --region europe-west1 --project acme-prod',
        source: 'cloud run · acme-web',
      },
    ]);
    expect(cli.calls.at(-1)).toMatchObject({
      bin: 'gcloud',
      args: ['run', 'services', 'list', '--format=json', '--project', 'acme-prod'],
    });
    const unmatched = await detectDeployCommands(gcp(), '/Users/dev/billing', {
      cli,
      ...fakeFs(['package.json'], {}, {}, '/Users/dev/billing'),
    });
    expect(unmatched).toEqual([
      {
        command: 'gcloud run deploy billing --source . --region europe-west1 --project acme-prod',
        source: 'cloud run',
      },
    ]);
  });

  it('gcp Cloud Run without gcloud or with a failing listing still suggests, without a region', async () => {
    const r = await detectDeployCommands(gcp(), '/Users/dev/billing', {
      cli: new FakeCliRunner(),
      ...fakeFs(['package.json'], {}, {}, '/Users/dev/billing'),
    });
    expect(r).toEqual([
      { command: 'gcloud run deploy billing --source . --project acme-prod', source: 'cloud run' },
    ]);
    const failing = new FakeCliRunner()
      .install('gcloud')
      .on('gcloud', ['run'], { exitCode: 1, stderr: 'boom' });
    expect(
      (
        await detectDeployCommands(gcp({}), '/Users/dev/billing', {
          cli: failing,
          ...fakeFs(['go.mod'], {}, {}, '/Users/dev/billing'),
        })
      )[0]?.command,
    ).toBe('gcloud run deploy billing --source .');
  });

  it('aws: SAM, Serverless, CDK, Copilot, Elastic Beanstalk and Amplify markers', async () => {
    const r = await detectDeployCommands({ provider: 'aws', config: {} }, '/repo', {
      cli: new FakeCliRunner(),
      ...fakeFs(['samconfig.toml', 'serverless.yml', 'cdk.json'], {
        copilot: ['x'],
        '.elasticbeanstalk': ['config.yml'],
        amplify: ['backend'],
      }),
    });
    expect(r.map((s) => s.command)).toEqual([
      'sam deploy',
      'npx serverless deploy',
      'npx cdk deploy',
      'copilot deploy',
      'eb deploy',
      'amplify push',
    ]);
  });

  it('supabase: migrations, plus functions when the folder has any, with the project ref from the target', async () => {
    const dbOnly = await detectDeployCommands(
      { provider: 'supabase', config: { projectRef: 'abcd' } },
      '/repo',
      {
        cli: new FakeCliRunner(),
        ...fakeFs(['supabase/config.toml']),
      },
    );
    expect(dbOnly).toEqual([
      { command: 'supabase db push --project-ref abcd', source: 'supabase/config.toml' },
    ]);
    const withFns = await detectDeployCommands({ provider: 'supabase', config: {} }, '/repo', {
      cli: new FakeCliRunner(),
      ...fakeFs(['supabase/config.toml'], { 'supabase/functions': ['hello'] }),
    });
    expect(withFns[0]?.command).toBe('supabase db push && supabase functions deploy');
    expect(
      await detectDeployCommands({ provider: 'supabase', config: {} }, '/repo', {
        cli: new FakeCliRunner(),
        ...fakeFs([]),
      }),
    ).toEqual([]);
  });

  it('github: workflows named for deploying, else workflows whose text mentions deploy', async () => {
    const named = await detectDeployCommands({ provider: 'github', config: {} }, '/repo', {
      cli: new FakeCliRunner(),
      ...fakeFs([], { '.github/workflows': ['ci.yml', 'deploy-prod.yml', 'release.yaml'] }),
    });
    expect(named.map((s) => s.command)).toEqual([
      'gh workflow run deploy-prod.yml',
      'gh workflow run release.yaml',
    ]);
    const byText = await detectDeployCommands({ provider: 'github', config: {} }, '/repo', {
      cli: new FakeCliRunner(),
      ...fakeFs(
        [],
        { '.github/workflows': ['ci.yml', 'pages.yml'] },
        { '.github/workflows/pages.yml': 'jobs:\n  deploy:\n    uses: actions/deploy-pages@v4' },
      ),
    });
    expect(byText.map((s) => s.command)).toEqual(['gh workflow run pages.yml']);
  });

  it('ssh: only a deploy.sh in the repo', async () => {
    expect(
      await detectDeployCommands({ provider: 'ssh', config: {} }, '/repo', {
        cli: new FakeCliRunner(),
        ...fakeFs(['deploy.sh']),
      }),
    ).toEqual([{ command: './deploy.sh', source: 'deploy.sh' }]);
    expect(
      await detectDeployCommands({ provider: 'ssh', config: {} }, '/repo', {
        cli: new FakeCliRunner(),
        ...fakeFs([]),
      }),
    ).toEqual([]);
  });
});
