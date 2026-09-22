import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    name: 'core',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/machines/**', 'src/policy/**', 'src/selectors/**', 'src/arcade/**'],
      thresholds: { branches: 100, lines: 100, functions: 100, statements: 100 },
    },
  },
});
