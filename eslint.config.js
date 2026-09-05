import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', 'design/**', '.planning/**', '**/storybook-static/**', '**/*.d.ts', '**/e2e/visual/vendor/**', '**/__baseline__/**', '**/coverage/**', '**/resources/cli/**', '**/release/**'] },
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
    files: ['**/*.config.{ts,js}', '**/.storybook/**', '**/*.stories.tsx', '**/vitest.workspace.ts', '**/drizzle.config.ts', '**/e2e/visual/global-setup.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'error' },
  },
);
