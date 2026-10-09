import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    name: 'desktop',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environmentMatchGlobs: [['src/renderer/**', 'jsdom']],
    // Git (and process spawning generally) is several times slower on Windows, and far slower again on hosted CI
    // runners: the git-heavy suites (checkpoints, seed repos, publish, land, merge) need more than the default 5s
    // there. A developer's Mac gets 20s: with several agents and test runs at once (Styx's own checks before a land)
    // a git suite outlasts 5s and fails for no reason. Tests that set their own limit scale it with `slow()`.
    ...(process.env['CI']
      ? { testTimeout: 60_000, hookTimeout: 60_000 }
      : process.platform === 'win32'
        ? { testTimeout: 30_000, hookTimeout: 30_000 }
        : { testTimeout: 20_000, hookTimeout: 20_000 }),
    // Git for Windows ships `core.autocrlf=true` in its system config, so every test repo would check out CRLF and
    // the byte-exact assertions on LF fixtures would fail. Test repos get LF, as they do on macOS and Linux.
    env:
      process.platform === 'win32'
        ? {
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_0: 'core.autocrlf',
            GIT_CONFIG_VALUE_0: 'false',
            GIT_CONFIG_KEY_1: 'core.eol',
            GIT_CONFIG_VALUE_1: 'lf',
          }
        : {},
  },
});
