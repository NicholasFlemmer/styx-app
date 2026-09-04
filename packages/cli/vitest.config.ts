import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: 'cli', include: ['src/**/*.test.ts'] } });
