import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  // The same `@/` alias as tsconfig, so tests can import app code (the sitemap) the way the app does.
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } },
  test: {
    name: 'website',
    include: ['lib/**/*.test.ts', 'components/**/*.test.tsx'],
    exclude: ['node_modules', '.next', 'out'],
  },
});
