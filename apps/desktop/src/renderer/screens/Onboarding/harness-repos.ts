import { env } from '../../state/bridge';
import type { ScannedRepo } from './onboarding-rows';

const YEAR = 365 * 24 * 60 * 60 * 1000;

/**
 * HARNESS ONLY (`STYX_E2E=1`): the prototype's six scanned repos (`obRepos`) instead of a machine scan, so the
 * `onboarding-2` baseline verifies real rows. Never used outside the e2e/visual harness.
 */
export const harnessScannedRepos = (now: number): ScannedRepo[] => [
  repo('~/code/acme-shop', 'https://github.com/acme/acme-shop.git', 'main', now),
  repo('~/code/blog-v2', 'https://github.com/acme/blog-v2.git', 'feat/mdx', now),
  repo('~/code/infra-tools', 'https://github.com/acme/infra-tools.git', 'main', now),
  repo('~/work/client-x', 'https://gitlab.com/client-x/client-x.git', 'main', now),
  repo('~/code/side-api', null, null, now),
  { ...repo('~/Downloads/tmp-fork', null, null, now - 2 * YEAR), suggested: false },
];

const repo = (path: string, remote: string | null, branch: string | null, lastModifiedAt: number): ScannedRepo => ({
  path,
  remote,
  branch,
  hasGit: true,
  source: 'scan',
  lastModifiedAt,
  suggested: true,
});

export const harnessReposEnabled = (): boolean => env().e2e === true;
