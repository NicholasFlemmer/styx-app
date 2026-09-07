import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fail } from '../ipc/bus';

/** Real path of `p`; when it does not exist yet, the real path of its nearest existing ancestor plus the rest. */
function realpathLenient(p: string): string {
  const missing: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return missing.length ? join(realpathSync(cur), ...missing) : realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      missing.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * `path.resolve(root, p)` must stay inside `root` (rules/ipc.md), checked on real paths so a symlink inside the
 * worktree cannot point outside it (L6; not-yet-existing files resolve through their parent). Returns the logical
 * absolute path so callers can still `relative()` it against the worktree path. Shared by the `fs.*` commands and
 * the file attachments of `session.sendMessage`.
 */
export function confine(root: string, p: string): string {
  const base = resolve(root);
  const full = resolve(base, p);
  const realBase = realpathLenient(base);
  const realFull = realpathLenient(full);
  if (realFull === realBase) return full;
  if (!realFull.startsWith(realBase + sep)) fail('fs-denied', `${p} is outside the worktree`);
  return full;
}
