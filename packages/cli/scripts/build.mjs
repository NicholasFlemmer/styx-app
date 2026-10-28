import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/styx.js',
  target: 'node22',
});
writeFileSync(new URL('../dist/package.json', import.meta.url), '{"type":"commonjs"}\n');
