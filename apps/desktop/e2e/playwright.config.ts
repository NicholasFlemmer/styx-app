import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: './test-results',
  projects: [
    { name: 'e2e', testMatch: /.*\.spec\.ts/, testIgnore: /visual\// },
    { name: 'visual', testMatch: /visual\/.*\.spec\.ts/ },
  ],
});
