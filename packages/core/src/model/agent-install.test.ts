import { describe, expect, it } from 'vitest';
import { GIT_DOWNLOAD_URL, INSTALL_PLATFORMS, gitInstallRecipes, installRecipes } from './agent-install';

const CONNECTABLE = ['claude', 'codex', 'gemini', 'cursor'] as const;

describe('installRecipes (#98)', () => {
  it('every connectable agent has a recipe per platform; the shell and an unknown OS have none', () => {
    for (const p of INSTALL_PLATFORMS)
      for (const a of CONNECTABLE) expect(installRecipes(a, p).length, `${a} on ${p}`).toBeGreaterThan(0);
    expect(installRecipes('shell', 'darwin')).toEqual([]);
    expect(installRecipes('claude', 'freebsd')).toEqual([]);
  });

  it('native installers stand alone; Gemini needs brew or npm, best first; Windows recipes run in PowerShell', () => {
    expect(installRecipes('claude', 'darwin')).toEqual([
      { command: 'curl -fsSL https://claude.ai/install.sh | bash', shell: 'sh', requires: null },
    ]);
    expect(installRecipes('gemini', 'linux').map((r) => [r.requires, r.command])).toEqual([
      ['brew', 'brew install gemini-cli'],
      ['npm', 'npm install -g @google/gemini-cli'],
    ]);
    expect(installRecipes('cursor', 'win32')).toEqual([
      { command: "irm 'https://cursor.com/install?win32=true' | iex", shell: 'powershell', requires: null },
    ]);
    for (const p of INSTALL_PLATFORMS)
      for (const a of CONNECTABLE)
        for (const r of installRecipes(a, p)) expect(r.shell).toBe(p === 'win32' ? 'powershell' : 'sh');
  });
});

describe('gitInstallRecipes (owner request: git in one click)', () => {
  it("the OS's own route: Apple's installer, winget's Git for Windows, the distro's package manager", () => {
    expect(gitInstallRecipes('darwin')).toEqual([
      { command: 'xcode-select --install', shell: 'sh', requires: null },
    ]);
    expect(gitInstallRecipes('win32')).toEqual([
      {
        command:
          'winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements',
        shell: 'powershell',
        requires: 'winget',
      },
    ]);
    expect(gitInstallRecipes('linux').map((r) => r.requires)).toEqual(['apt-get', 'dnf']);
    expect(gitInstallRecipes('freebsd')).toEqual([]);
    expect(GIT_DOWNLOAD_URL).toBe('https://git-scm.com/downloads');
  });
});
