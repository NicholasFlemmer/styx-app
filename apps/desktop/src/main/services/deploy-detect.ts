import type { Target } from '@styx/core';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CliRunner } from '../providers/cli-runner';

/** Provider ids, regions, refs, service names: letters, digits, `.`, `_`, `-`, `:` only — never shell text. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Workflow file names as `gh workflow run` takes them. */
const SAFE_FILE = /^[A-Za-z0-9._-]+\.ya?ml$/i;

export interface DeploySuggestion {
  command: string;
  /** What the suggestion was read from (`app.yaml`, `cloud run · acme-web`, `samconfig.toml` …). */
  source: string;
}

export interface DeployDetectDeps {
  cli: CliRunner;
  exists?: (path: string) => boolean;
  readDir?: (path: string) => string[];
  readText?: (path: string) => string | null;
}

const RUN_MARKERS = ['Dockerfile', 'package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Gemfile'];

/** `gcloud run services list --format=json` rows, as much of them as the suggestion needs. */
const parseRunServices = (json: string): { name: string; region: string | null }[] => {
  try {
    const rows = JSON.parse(json) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((r) => {
      const meta = (r as { metadata?: { name?: unknown; labels?: Record<string, unknown> } }).metadata;
      const name = typeof meta?.name === 'string' ? meta.name : null;
      const region = meta?.labels?.['cloud.googleapis.com/location'];
      if (name === null || !SAFE_ID.test(name)) return [];
      return [{ name, region: typeof region === 'string' && SAFE_ID.test(region) ? region : null }];
    });
  } catch {
    return [];
  }
};

/**
 * What a target most likely deploys with, read from the repo and, for Cloud Run, from the provider (owner
 * question: "what about support for the other targets?" — only Vercel had a built-in verb). Suggestions are
 * ordered most-specific first; the first one pre-fills the target's deploy command, which the user can edit.
 * Never runs anything that changes state: the only CLI call is a service listing.
 */
export async function detectDeployCommands(
  target: Pick<Target, 'provider' | 'config'>,
  projectPath: string,
  deps: DeployDetectDeps,
): Promise<DeploySuggestion[]> {
  const exists = deps.exists ?? ((p) => existsSync(p));
  const readDir = deps.readDir ?? ((p) => (existsSync(p) ? readdirSync(p) : []));
  const readText =
    deps.readText ??
    ((p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    });
  const has = (name: string) => exists(join(projectPath, name));
  // Config values come from the target row, which a committed `.styx/project.json` can seed: only a plain
  // identifier is ever composed into a command Styx suggests (and the agent is invited to run).
  const cfg = (key: string): string | null => {
    const v = target.config[key];
    return typeof v === 'string' && SAFE_ID.test(v.trim()) ? v.trim() : null;
  };
  const out: DeploySuggestion[] = [];

  switch (target.provider) {
    case 'vercel':
      return []; // built in
    case 'gcp': {
      const projectId = cfg('projectId');
      const project = projectId === null ? '' : ` --project ${projectId}`;
      if (has('app.yaml') || has('app.yml'))
        out.push({ command: `gcloud app deploy --quiet${project}`, source: 'app.yaml' });
      if (has('firebase.json'))
        out.push({
          command: `firebase deploy${projectId === null ? '' : ` --project ${projectId}`}`,
          source: 'firebase.json',
        });
      if (has('cloudbuild.yaml') || has('cloudbuild.yml')) {
        const file = has('cloudbuild.yaml') ? 'cloudbuild.yaml' : 'cloudbuild.yml';
        out.push({ command: `gcloud builds submit --config ${file}${project}`, source: file });
      }
      if (RUN_MARKERS.some(has)) {
        const folder = basename(projectPath);
        const r = await deps.cli
          .run(
            'gcloud',
            [
              'run',
              'services',
              'list',
              '--format=json',
              ...(projectId === null ? [] : ['--project', projectId]),
            ],
            {
              timeoutMs: 15_000,
              cwd: projectPath,
            },
          )
          .catch(() => null);
        const services = r !== null && r.exitCode === 0 ? parseRunServices(r.stdout) : [];
        const match =
          services.find((s) => s.name === folder) ?? (services.length === 1 ? services[0] : undefined);
        const regions = new Set(services.map((s) => s.region).filter((x): x is string => x !== null));
        const region = match?.region ?? cfg('region') ?? (regions.size === 1 ? [...regions][0]! : null);
        const name = match?.name ?? folder;
        out.push({
          command: `gcloud run deploy ${name} --source .${region === null ? '' : ` --region ${region}`}${project}`,
          source: match === undefined ? 'cloud run' : `cloud run · ${match.name}`,
        });
      }
      return out;
    }
    case 'aws': {
      if (has('samconfig.toml') || has('template.yaml') || has('template.yml'))
        out.push({
          command: 'sam deploy',
          source: has('samconfig.toml') ? 'samconfig.toml' : 'template.yaml',
        });
      if (has('serverless.yml') || has('serverless.yaml'))
        out.push({ command: 'npx serverless deploy', source: 'serverless.yml' });
      if (has('cdk.json')) out.push({ command: 'npx cdk deploy', source: 'cdk.json' });
      if (has('copilot')) out.push({ command: 'copilot deploy', source: 'copilot/' });
      if (has('.elasticbeanstalk')) out.push({ command: 'eb deploy', source: '.elasticbeanstalk/' });
      if (has('amplify')) out.push({ command: 'amplify push', source: 'amplify/' });
      return out;
    }
    case 'supabase': {
      if (!has(join('supabase', 'config.toml'))) return out;
      const ref = cfg('projectRef') ?? cfg('ref');
      const flag = ref === null ? '' : ` --project-ref ${ref}`;
      const functions = readDir(join(projectPath, 'supabase', 'functions')).length > 0;
      out.push({
        command: functions
          ? `supabase db push${flag} && supabase functions deploy${flag}`
          : `supabase db push${flag}`,
        source: functions ? 'supabase/config.toml + functions' : 'supabase/config.toml',
      });
      return out;
    }
    case 'github': {
      const dir = join(projectPath, '.github', 'workflows');
      const files = readDir(dir).filter((f) => SAFE_FILE.test(f));
      const deployish = files.filter((f) => /deploy|release|publish/i.test(f));
      const fallback = files.filter((f) => /deploy/i.test(readText(join(dir, f)) ?? ''));
      for (const f of deployish.length > 0 ? deployish : fallback)
        out.push({ command: `gh workflow run ${f}`, source: `.github/workflows/${f}` });
      return out;
    }
    case 'ssh': {
      if (has('deploy.sh')) out.push({ command: './deploy.sh', source: 'deploy.sh' });
      return out;
    }
  }
}
