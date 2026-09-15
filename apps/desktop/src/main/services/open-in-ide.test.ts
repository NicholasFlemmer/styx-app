import { describe, expect, it } from 'vitest';
import { launchArgs, type LaunchSpec } from './open-in-ide';

describe('launchArgs (Open in {IDE})', () => {
  it.each<[string, string, string, NodeJS.Platform, LaunchSpec]>([
    [
      'JetBrains bundle on macOS → open -a',
      'open -a "WebStorm"',
      '/Users/me/code/acme-shop',
      'darwin',
      { file: 'open', args: ['-a', 'WebStorm', '/Users/me/code/acme-shop'], shell: false, detached: false },
    ],
    [
      'unquoted open -a form, app name with spaces',
      'open -a Visual Studio Code',
      '/Users/me/work/blog v2',
      'darwin',
      {
        file: 'open',
        args: ['-a', 'Visual Studio Code', '/Users/me/work/blog v2'],
        shell: false,
        detached: false,
      },
    ],
    [
      'code on PATH → detached binary',
      'code',
      '/Users/me/code/acme-shop/src/index.ts',
      'darwin',
      { file: 'code', args: ['/Users/me/code/acme-shop/src/index.ts'], shell: false, detached: true },
    ],
    ['cursor', 'cursor', '/w', 'darwin', { file: 'cursor', args: ['/w'], shell: false, detached: true }],
    ['windsurf', 'windsurf', '/w', 'linux', { file: 'windsurf', args: ['/w'], shell: false, detached: true }],
    [
      'zed',
      '/usr/local/bin/zed',
      '/w',
      'darwin',
      { file: '/usr/local/bin/zed', args: ['/w'], shell: false, detached: true },
    ],
    [
      'nvim',
      '/opt/homebrew/bin/nvim',
      '/w',
      'darwin',
      { file: '/opt/homebrew/bin/nvim', args: ['/w'], shell: false, detached: true },
    ],
    [
      'JetBrains exe on Windows → plain binary',
      'C:\\Program Files\\JetBrains\\WebStorm 2025.1\\bin\\webstorm64.exe',
      'C:\\dev\\acme shop',
      'win32',
      {
        file: 'C:\\Program Files\\JetBrains\\WebStorm 2025.1\\bin\\webstorm64.exe',
        args: ['C:\\dev\\acme shop'],
        shell: false,
        detached: true,
      },
    ],
    [
      'VS Code .cmd shim on Windows → one quoted command line through the shell',
      'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      'C:\\dev\\acme shop',
      'win32',
      {
        file: '"C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd" "C:\\dev\\acme shop"',
        args: [],
        shell: true,
        detached: true,
      },
    ],
    [
      'a .cmd path on macOS is just a file name',
      '/x/code.cmd',
      '/w',
      'darwin',
      { file: '/x/code.cmd', args: ['/w'], shell: false, detached: true },
    ],
  ])('%s', (_label, launcher, path, platform, expected) => {
    expect(launchArgs(launcher, path, platform)).toEqual(expected);
  });
});
