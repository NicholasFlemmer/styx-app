#!/usr/bin/env node
// Builds Storybook, serves storybook-static on a local port and runs @storybook/test-runner (axe via .storybook/test-runner.ts).
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(fileURLToPath(import.meta.url), '../..');
const dist = join(pkg, 'storybook-static');
const bin = (name) => join(pkg, 'node_modules/.bin', name);
const binOrRoot = (name) =>
  existsSync(bin(name)) ? bin(name) : resolve(pkg, '../../node_modules/.bin', name);
const extra = process.argv.slice(2);

if (!process.env.STYX_SB_SKIP_BUILD) {
  const build = spawnSync(binOrRoot('storybook'), ['build', '--quiet', '--test'], {
    cwd: pkg,
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
};
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file = normalize(join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist)) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  const runner = spawn(binOrRoot('test-storybook'), ['--url', url, ...extra], {
    cwd: pkg,
    stdio: 'inherit',
    env: { ...process.env, TARGET_URL: url },
  });
  runner.on('exit', (code) => {
    server.close();
    process.exit(code ?? 1);
  });
});
