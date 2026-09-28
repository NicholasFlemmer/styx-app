import { watch as fsWatch } from 'node:fs';
import { join, resolve } from 'node:path';
import { TREE_IGNORED_DIRS } from '@styx/core';
import type { FsWatcherLike, WatchFactory } from './hunk-service';
import { logger } from './logger';

/**
 * Folders whose changes never matter to the files pane or to an agent's hunks: the files pane's own skip list
 * (version control, dependencies, Styx's folder, build and cache output), skipped by name at any depth.
 */
export const IGNORED_DIRS: ReadonlySet<string> = new Set(TREE_IGNORED_DIRS);

/** Whether a path *inside* the watched folder is under one of `IGNORED_DIRS`. */
export const isIgnoredPath = (rel: string): boolean =>
  rel.split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg));

/**
 * One native recursive watcher per folder (FSEvents on macOS, ReadDirectoryChangesW on Windows): no handle per
 * file, whatever the folder's size. chokidar 5 watched every file on its own — about 10,000 open files and a steady
 * stream of events for one Next.js project with its dev server running, which is what made Styx heavy and slow.
 * Changes under `IGNORED_DIRS` are dropped before anyone hears of them. Falls back to chokidar where the platform
 * has no recursive watch.
 */
export const worktreeWatch: WatchFactory = async (path) => {
  const root = resolve(path);
  const listeners: ((event: string, path: string) => void)[] = [];
  let watcher: ReturnType<typeof fsWatch>;
  try {
    watcher = fsWatch(root, { recursive: true, persistent: true }, (event, filename) => {
      const rel = filename === null ? '' : filename.toString();
      if (rel !== '' && isIgnoredPath(rel)) return;
      const full = rel === '' ? root : join(root, rel);
      for (const cb of listeners) cb(event, full);
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') throw e;
    const { chokidarWatch } = await import('./hunk-service');
    return chokidarWatch(path);
  }
  watcher.on('error', (e) => logger.warn('watch: failed', { path: root, error: e.message }));
  return {
    on: (_event: 'all', cb: (event: string, path: string) => void) => {
      listeners.push(cb);
    },
    close: async () => watcher.close(),
  } satisfies FsWatcherLike;
};
