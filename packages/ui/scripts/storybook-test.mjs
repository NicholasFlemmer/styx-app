#!/usr/bin/env node
// Builds Storybook, serves storybook-static on a local port and runs @storybook/test-runner (axe via .storybook/test-runner.ts).
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(fileURLToPath(import.meta.url), '../..');
const dist = join(pkg, 'storybook-static');
// On Windows `.bin/<name>` is a POSIX shell script; the runnable shim is `<name>.cmd`, and since Node's 2024
// CVE-2024-27980 fix a `.cmd` only starts through a shell (otherwise spawn fails with EINVAL and no output).
const WIN = process.platform === 'win32';
const bin = (name) => join(pkg, 'node_modules/.bin', WIN ? `${name}.cmd` : name);
const binOrRoot = (name) =>
  existsSync(bin(name)) ? bin(name) : resolve(pkg, '../../node_modules/.bin', WIN ? `${name}.cmd` : name);
/** spawn options for a `.bin` shim: through the shell on Windows, with the path quoted for it. */
const run = (name) =>
  WIN ? { cmd: `"${binOrRoot(name)}"`, shell: true } : { cmd: binOrRoot(name), shell: false };
// On CI, a few workers: each starts its own browser, and on the Windows runner a burst of them can leave one
// worker timing out on its browser connection (ETIMEDOUT ::1) before a single story runs.
const extra = process.argv.slice(2);
if (process.env.CI && !extra.some((a) => a.startsWith('--maxWorkers'))) extra.push('--maxWorkers=2');

if (!process.env.STYX_SB_SKIP_BUILD) {
  const sb = run('storybook');
  const build = spawnSync(sb.cmd, ['build', '--quiet', '--test'], {
    cwd: pkg,
    stdio: 'inherit',
    shell: sb.shell,
  });
  if (build.error) console.error(build.error);
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
  const tr = run('test-storybook');
  const runner = spawn(tr.cmd, ['--url', url, ...extra], {
    cwd: pkg,
    stdio: 'inherit',
    shell: tr.shell,
    env: { ...process.env, TARGET_URL: url },
  });
  runner.on('error', (err) => {
    console.error(err);
    server.close();
    process.exit(1);
  });
  runner.on('exit', (code) => {
    server.close();
    process.exit(code ?? 1);
  });
});
