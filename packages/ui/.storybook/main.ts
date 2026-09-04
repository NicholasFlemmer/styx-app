import type { StorybookConfig } from '@storybook/react-vite';

/** ADR-0009: Storybook on the Vite builder; theme/platform are toolbar globals (see preview.ts). */
const config: StorybookConfig = {
  framework: { name: '@storybook/react-vite', options: {} },
  stories: ['../src/**/*.stories.tsx'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  viteFinal: (viteConfig) => ({
    ...viteConfig,
    // Match vitest.config.ts so `s.someClass` resolves identically in stories and tests.
    css: { ...viteConfig.css, modules: { ...viteConfig.css?.modules, localsConvention: 'camelCaseOnly' } },
  }),
};

export default config;
