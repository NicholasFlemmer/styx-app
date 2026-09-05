import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * `connect-src ws://localhost:*` exists only for Vite HMR. Production bundles are served from `file://`, so the
 * built index.html keeps `connect-src 'self'` alone (the source file stays dev-friendly).
 */
const productionCsp = (): Plugin => ({
  name: 'styx-production-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace(/connect-src 'self' ws:\/\/localhost:\*/, "connect-src 'self'"),
});

export default defineConfig({
  main: {
    // Only native modules stay external; everything else is bundled so the packaged app never `require`s
    // ESM-only packages at runtime (execa/chokidar hang under require() inside the packaged app).
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@styx/core', '@styx/broker', '@styx/tokens',
          '@aws-sdk/client-sts', '@msgpack/msgpack', '@modelcontextprotocol/sdk', 'chokidar', 'drizzle-orm',
          'electron-log', 'execa', 'jose', 'parse-diff', 'ulid', 'zod',
        ],
      }),
    ],
    resolve: { alias: { '@main': resolve('src/main') } },
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@styx/core'] })],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } },
  },
  renderer: {
    plugins: [react(), productionCsp()],
    resolve: { alias: { '@renderer': resolve('src/renderer') } },
    css: { modules: { localsConvention: 'camelCaseOnly' } },
    worker: { format: 'es' },
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } },
  },
});
