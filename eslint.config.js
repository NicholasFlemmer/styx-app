import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', 'design/**', '.planning/**', '**/.source/**', '**/storybook-static/**', '**/*.d.ts', '**/e2e/visual/vendor/**', '**/__baseline__/**', '**/coverage/**', '**/resources/cli/**', '**/release/**', '**/.next/**', '**/next-env.d.ts'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportDefaultDeclaration', message: 'Use named exports (config files are exempt via overrides).' },
      ],
    },
  },
  {
    // Next.js route files (page, layout, metadata routes) are default exports by framework contract.
    files: ['**/*.config.{ts,js}', '**/.storybook/**', '**/*.stories.tsx', '**/vitest.workspace.ts', '**/drizzle.config.ts', '**/e2e/visual/global-setup.ts', 'apps/website/app/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // electron-builder hooks are CommonJS by contract: it `require()`s them from its own process.
    files: ['**/build/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'error' },
  },
);
