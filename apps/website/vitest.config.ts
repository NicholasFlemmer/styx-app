import { defineConfig } from 'vitest/config';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    name: 'website',
    include: ['lib/**/*.test.ts', 'components/**/*.test.tsx'],
    exclude: ['node_modules', '.next', 'out'],
  },
});
