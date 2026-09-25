import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isIgnoredPath, worktreeWatch } from './worktree-watch';

describe('isIgnoredPath', () => {
  it.each([
    ['.next/server/app/page.js', true],
    ['apps/web/.next/cache/x', true],
    ['node_modules/react/index.js', true],
    ['packages/a/dist/index.js', true],
    ['.git/HEAD', true],
    ['target/debug/app', true],
    ['src/app/page.tsx', false],
    ['next.config.ts', false],
    ['docs/building.md', false],
    ['src/dist-utils.ts', false],
  ])('%s → %s', (rel, ignored) => expect(isIgnoredPath(rel)).toBe(ignored));
});

describe('worktreeWatch', () => {
  it('hears source changes, not build output, and holds no file open per file however big the folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'styx-watch-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, '.next', 'server'), { recursive: true });
    for (let i = 0; i < 2000; i++) writeFileSync(join(root, '.next', 'server', `chunk-${i}.js`), 'x');
    const w = await worktreeWatch(root);
    try {
      const heard: string[] = [];
      w.on('all', (_e, p) => heard.push(p));
      await new Promise((r) => setTimeout(r, 300)); // FSEvents starts delivering shortly after the watch opens
      if (process.platform === 'darwin') {
        const open = execFileSync('lsof', ['-p', String(process.pid)], { encoding: 'utf8' });
        expect(open.split('\n').filter((l) => l.includes(join(root, '.next'))).length).toBe(0);
      }
      writeFileSync(join(root, '.next', 'server', 'chunk-1.js'), 'rebuilt');
      await new Promise((r) => setTimeout(r, 400));
      expect(heard.filter((p) => p.includes('.next'))).toEqual([]);
      writeFileSync(join(root, 'src', 'page.tsx'), 'export {}');
      await vi.waitFor(() => expect(heard.some((p) => p.endsWith(join('src', 'page.tsx')))).toBe(true), {
        timeout: 3000,
      });
    } finally {
      await w.close();
    }
  });
});
