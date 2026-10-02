import type { Agent } from './common';

/**
 * How Styx installs an agent CLI that is not on the machine (Connect agent modal → Install; owner addition,
 * docs/handoff-discrepancies #98): each vendor's own documented command, verbatim, run in the user's login shell
 * (or PowerShell) inside the modal's terminal. Nothing here is interpolated: the renderer sends only the agent id
 * and main runs the matching constant.
 *
 * Sources (2026-09): code.claude.com/docs/en/setup · github.com/openai/codex · github.com/google-gemini/gemini-cli ·
 * cursor.com/docs/cli/installation.
 */
export type InstallShell = 'sh' | 'powershell';

export interface InstallRecipe {
  /** The vendor's documented command; shown before it runs and as the terminal label. */
  command: string;
  shell: InstallShell;
  /** A tool that must already be on the shell PATH (`brew`, `npm`); null when the installer stands on its own. */
  requires: string | null;
}

type InstallPlatform = 'darwin' | 'linux' | 'win32';

const POSIX: InstallPlatform[] = ['darwin', 'linux'];

const sh = (command: string, requires: string | null = null): InstallRecipe => ({
  command,
  shell: 'sh',
  requires,
});
const ps = (command: string, requires: string | null = null): InstallRecipe => ({
  command,
  shell: 'powershell',
  requires,
});

/** Recipes in preference order per agent and platform; the first whose `requires` is present is the one run. */
const RECIPES: Record<Exclude<Agent, 'shell'>, Record<InstallPlatform, InstallRecipe[]>> = {
  claude: {
    darwin: [sh('curl -fsSL https://claude.ai/install.sh | bash')],
    linux: [sh('curl -fsSL https://claude.ai/install.sh | bash')],
    win32: [ps('irm https://claude.ai/install.ps1 | iex')],
  },
  codex: {
    darwin: [sh('curl -fsSL https://chatgpt.com/codex/install.sh | sh')],
    linux: [sh('curl -fsSL https://chatgpt.com/codex/install.sh | sh')],
    win32: [ps('irm https://chatgpt.com/codex/install.ps1 | iex')],
  },
  // Gemini CLI has no native installer: Homebrew when present, else the npm package.
  gemini: {
    darwin: [sh('brew install gemini-cli', 'brew'), sh('npm install -g @google/gemini-cli', 'npm')],
    linux: [sh('brew install gemini-cli', 'brew'), sh('npm install -g @google/gemini-cli', 'npm')],
    win32: [ps('npm install -g @google/gemini-cli', 'npm')],
  },
  cursor: {
    darwin: [sh('curl https://cursor.com/install -fsS | bash')],
    linux: [sh('curl https://cursor.com/install -fsS | bash')],
    win32: [ps("irm 'https://cursor.com/install?win32=true' | iex")],
  },
};

const isInstallPlatform = (p: string): p is InstallPlatform =>
  p === 'darwin' || p === 'linux' || p === 'win32';

/** The install commands Styx may run for an agent on a platform, best first; [] for the shell or an unknown OS. */
export const installRecipes = (agent: Agent, platform: string): InstallRecipe[] => {
  if (agent === 'shell' || !isInstallPlatform(platform)) return [];
  return RECIPES[agent][platform];
};

export const INSTALL_PLATFORMS: readonly InstallPlatform[] = [...POSIX, 'win32'];

/**
 * Git, which Styx does not need to start but does need to give each agent its own copy of the code (owner request:
 * "make it super easy to install"). The OS's own route, run as-is: on macOS Apple's Command Line Tools installer
 * (a system dialog with one button), on Windows winget's official Git for Windows package, on Linux the distro's
 * package manager. Where none applies the renderer offers `GIT_DOWNLOAD_URL`.
 */
const GIT_RECIPES: Record<InstallPlatform, InstallRecipe[]> = {
  darwin: [sh('xcode-select --install')],
  win32: [
    ps(
      'winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements',
      'winget',
    ),
  ],
  linux: [sh('sudo apt-get install -y git', 'apt-get'), sh('sudo dnf install -y git', 'dnf')],
};

export const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads';

/** The install commands Styx may run for git on a platform, best first; [] for an unknown OS. */
export const gitInstallRecipes = (platform: string): InstallRecipe[] =>
  isInstallPlatform(platform) ? GIT_RECIPES[platform] : [];
