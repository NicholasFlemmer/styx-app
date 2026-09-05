import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { confine } from './worktree';

describe('confine (L6)', () => {
  const setup = () => {
    const base = mkdtempSync(join(tmpdir(), 'styx-confine-'));
    const root = join(base, 'wt');
    const outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'nope');
    writeFileSync(join(root, 'inside.txt'), 'ok');
    symlinkSync(outside, join(root, 'escape'));
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    return { root, outside };
  };

  it('resolves symlinks on both sides before the prefix check', () => {
    const { root } = setup();
    expect(() => confine(root, 'escape/secret.txt')).toThrow(/outside the worktree/);
    expect(() => confine(root, 'escape.txt')).toThrow(/outside the worktree/);
    expect(() => confine(root, 'escape/new-file.txt')).toThrow(/outside the worktree/);
    expect(() => confine(root, '../outside/secret.txt')).toThrow(/outside the worktree/);
    expect(() => confine(root, '/etc/passwd')).toThrow(/outside the worktree/);
  });

  it('keeps logical paths for files inside the worktree, including ones that do not exist yet', () => {
    const { root } = setup();
    expect(confine(root, 'inside.txt')).toBe(resolve(root, 'inside.txt'));
    expect(confine(root, 'new/dir/file.txt')).toBe(resolve(root, 'new/dir/file.txt'));
    expect(confine(root, '.')).toBe(resolve(root));
    expect(confine(root, '')).toBe(resolve(root));
    // A symlinked *root* (e.g. /tmp → /private/tmp on macOS) is fine when the target stays inside it.
    const link = join(root, '..', 'wt-link');
    symlinkSync(root, link);
    expect(confine(link, 'inside.txt')).toBe(resolve(link, 'inside.txt'));
    expect(() => confine(link, 'escape/secret.txt')).toThrow(/outside the worktree/);
  });
});
