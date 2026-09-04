import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@styx/core', '@styx/broker', '@styx/tokens'] })],
    resolve: { alias: { '@main': resolve('src/main') } },
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@styx/core'] })],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@renderer': resolve('src/renderer') } },
    css: { modules: { localsConvention: 'camelCaseOnly' } },
    worker: { format: 'es' },
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } },
  },
});
