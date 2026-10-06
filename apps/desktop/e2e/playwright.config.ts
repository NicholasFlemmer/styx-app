import { defineConfig } from '@playwright/test';

// One id per run, inherited by workers, so visual results land in visual/output/<runId>/ (see visual/screens.spec.ts).
process.env['STYX_VISUAL_RUN'] ??= `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;

export default defineConfig({
  testDir: '.',
  globalSetup: './visual/global-setup.ts',
  // Hosted CI runners run git and Electron several times slower (Windows most of all); same tests, more time.
  timeout: process.env['CI'] ? 180_000 : 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: './test-results',
  projects: [
    { name: 'e2e', testMatch: /.*\.spec\.ts/, testIgnore: /visual\// },
    // axe over every harness state (also runs inside `e2e`: `pnpm e2e -- --grep a11y`).
    { name: 'a11y', testMatch: /a11y\.spec\.ts/ },
    { name: 'visual', testMatch: /visual\/.*\.spec\.ts/ },
    // User simulations (owner request): long, soft-failing walkthroughs that write docs/reports/user-sim/<area>.md.
    // The README GIF (`pnpm -F @styx/desktop readme:gif`): records, never asserts much; not part of `pnpm e2e`.
    { name: 'readme', testMatch: /readme\/.*\.rec\.ts/, timeout: 5 * 60_000 },
    { name: 'sim', testMatch: /sim\/.*\.sim\.ts/, timeout: 30 * 60_000 },
  ],
});
