import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: 'broker', include: ['src/**/*.test.ts'] } });
