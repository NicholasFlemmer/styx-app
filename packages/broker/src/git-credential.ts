export const GIT_CREDENTIAL_TOOL = 'git-credential-styx';

export function githubRepository(path: string): string | null {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]+)$/.exec(path);
  const owner = match?.[1];
  const repo = match?.[2];
  if (match?.[0] !== path || owner === undefined || repo === undefined || repo === '.' || repo === '..')
    return null;
  return `${owner}/${repo}`.toLowerCase();
}

export function gitCredentialRequest(
  argv: readonly string[],
): { repository: string; operation: 'fetch' | 'push' } | null {
  const [action, operation, url] = argv;
  if (
    argv.length !== 3 ||
    action !== 'get' ||
    (operation !== 'fetch' && operation !== 'push') ||
    url === undefined
  )
    return null;
  const prefix = 'https://github.com/';
  if (!url.startsWith(prefix)) return null;
  const repository = githubRepository(url.slice(prefix.length).replace(/\.git$/, ''));
  return repository === null ? null : { repository, operation };
}
