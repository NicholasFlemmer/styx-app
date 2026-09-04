import type { DiffLine, Hunk } from '../model/hunk';

export interface DiffFile {
  /** New path ("/dev/null" deletions keep the old path). */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  hunks: Hunk[];
  added: number;
  removed: number;
}

export interface UnifiedDiff {
  files: DiffFile[];
}

/** FNV-1a 32-bit, hex; pure (no node:crypto) so it runs in any context. */
export const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/** Content hash: file + line kinds/text, independent of line numbers so a shifted hunk keeps its identity. */
export const hunkHash = (file: string, lines: readonly Pick<DiffLine, 'kind' | 'text'>[]): string =>
  fnv1a(`${file}\n${lines.map((l) => `${l.kind[0]}${l.text}`).join('\n')}`);

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

const stripPrefix = (p: string): string | null => {
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
};

const int = (s: string | undefined, fallback: number): number =>
  s === undefined ? fallback : Number.parseInt(s, 10);

/** Parse `git diff -U3` output. Tolerates missing `diff --git` headers (plain `---`/`+++`). */
export const parseUnifiedDiff = (text: string): UnifiedDiff => {
  const files: DiffFile[] = [];
  const lines = text.split('\n');
  let file: DiffFile | null = null;
  let hunk: {
    header: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: DiffLine[];
  } | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const hunkOpen = (): boolean => hunk !== null && (oldLeft > 0 || newLeft > 0);

  const finishHunk = (): void => {
    if (file === null || hunk === null) return;
    const patchLines = [
      `--- ${file.oldPath === null ? '/dev/null' : `a/${file.oldPath}`}`,
      `+++ ${file.newPath === null ? '/dev/null' : `b/${file.newPath}`}`,
      hunk.header,
      ...hunk.lines.map((l) => (l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' ') + l.text),
    ];
    file.hunks.push({
      file: file.path,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      header: hunk.header,
      lines: hunk.lines,
      hunkHash: hunkHash(file.path, hunk.lines),
      patch: `${patchLines.join('\n')}\n`,
    });
    hunk = null;
  };

  const startFile = (): DiffFile => {
    finishHunk();
    const next: DiffFile = {
      path: '',
      oldPath: null,
      newPath: null,
      status: 'modified',
      hunks: [],
      added: 0,
      removed: 0,
    };
    files.push(next);
    return next;
  };

  const finalizeStatus = (f: DiffFile): void => {
    if (f.oldPath === null && f.newPath !== null) f.status = 'added';
    else if (f.newPath === null && f.oldPath !== null) f.status = 'deleted';
    else if (f.oldPath !== null && f.newPath !== null && f.oldPath !== f.newPath) f.status = 'renamed';
    f.path = f.newPath ?? f.oldPath ?? f.path;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('diff --git ')) {
      file = startFile();
      continue;
    }
    if (line.startsWith('--- ') && !hunkOpen()) {
      finishHunk();
      if (file === null || file.oldPath !== null || file.newPath !== null) file = startFile();
      file.oldPath = stripPrefix(line.slice(4).split('\t')[0] ?? '');
      continue;
    }
    if (line.startsWith('+++ ') && !hunkOpen()) {
      finishHunk();
      if (file === null) file = startFile();
      file.newPath = stripPrefix(line.slice(4).split('\t')[0] ?? '');
      finalizeStatus(file);
      continue;
    }
    const m = HUNK_RE.exec(line);
    if (m !== null) {
      if (file === null) file = startFile();
      finishHunk();
      const oldStart = int(m[1], 0);
      const oldLines = int(m[2], 1);
      const newStart = int(m[3], 0);
      const newLines = int(m[4], 1);
      hunk = {
        header: `@@ -${m[1]}${m[2] === undefined ? '' : `,${m[2]}`} +${m[3]}${m[4] === undefined ? '' : `,${m[4]}`} @@`,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
      };
      oldLine = oldStart;
      newLine = newStart;
      oldLeft = oldLines;
      newLeft = newLines;
      continue;
    }
    if (hunk === null || file === null) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const kind = line[0];
    const body = line.slice(1);
    if (kind === '+') {
      hunk.lines.push({ kind: 'add', text: body, oldLine: null, newLine });
      newLine += 1;
      newLeft -= 1;
      file.added += 1;
    } else if (kind === '-') {
      hunk.lines.push({ kind: 'remove', text: body, oldLine, newLine: null });
      oldLine += 1;
      oldLeft -= 1;
      file.removed += 1;
    } else if (kind === ' ' || line === '') {
      hunk.lines.push({ kind: 'context', text: body, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      oldLeft -= 1;
      newLeft -= 1;
    } else {
      // Anything else ends the hunk (e.g. a stray header without diff --git).
      finishHunk();
    }
  }
  finishHunk();
  return { files: files.filter((f) => f.hunks.length > 0 || f.oldPath !== null || f.newPath !== null) };
};

/** "+142 −38 · 3 files" style summary inputs. */
export const diffTotals = (diff: UnifiedDiff): { added: number; removed: number; files: number } => ({
  added: diff.files.reduce((n, f) => n + f.added, 0),
  removed: diff.files.reduce((n, f) => n + f.removed, 0),
  files: diff.files.length,
});
