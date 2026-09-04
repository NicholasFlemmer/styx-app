import { appendFile, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** `.git/info/exclude` for a checkout, following the `gitdir:` pointer of linked worktrees to the common dir. */
export async function gitExcludeFile(worktreePath: string): Promise<string | null> {
  const dotGit = join(worktreePath, '.git');
  try {
    const st = await stat(dotGit);
    if (st.isDirectory()) return join(dotGit, 'info', 'exclude');
    const text = await readFile(dotGit, 'utf8');
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (!m?.[1]) return null;
    const gitdir = resolve(worktreePath, m[1].trim());
    // <repo>/.git/worktrees/<name> → <repo>/.git
    return join(dirname(dirname(gitdir)), 'info', 'exclude');
  } catch {
    return null;
  }
}

/** Adds `pattern` to the repo's local exclude file once (never touches `.gitignore`). */
export async function excludeLocally(worktreePath: string, pattern: string): Promise<void> {
  const file = await gitExcludeFile(worktreePath);
  if (!file) return;
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch {
    current = '';
  }
  if (current.split('\n').some((l) => l.trim() === pattern)) return;
  await appendFile(file, `${current.endsWith('\n') || current === '' ? '' : '\n'}${pattern}\n`);
}
