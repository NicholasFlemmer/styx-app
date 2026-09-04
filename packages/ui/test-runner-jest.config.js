// Jest config for @storybook/test-runner (`pnpm storybook:test`).
// The axe hooks live in .storybook/test-runner-hooks.js instead of .storybook/test-runner.ts because Storybook 10's
// config loader calls module.register(), which Jest 30 refuses inside the test sandbox.
import { getJestConfig } from '@storybook/test-runner';

const base = getJestConfig();

export default {
  ...base,
  rootDir: import.meta.dirname,
  setupFilesAfterEnv: [...(base.setupFilesAfterEnv ?? []), '<rootDir>/.storybook/test-runner-hooks.js'],
};
