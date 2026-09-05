import { parseUnifiedDiff, type AgentChange, type DiffLine, type UnifiedDiff } from '@styx/core';

/** One rendered line of a diff block: hunk/file headers are muted, additions get `--add`. */
export type DiffRowKind = 'header' | 'context' | 'add' | 'remove';

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
}

/**
 * Gutter style. The prototype renders the Repo lane diff with the raw unified-diff sigil (`+import …`,
 * ` import …`) and Diff review hunks with a sigil plus one space (`+ import …`, `  import …`).
 */
export type DiffGutter = 'compact' | 'spaced';

const SIGIL: Record<DiffRowKind, string> = { header: '', context: ' ', add: '+', remove: '-' };

/** Text for a row including its gutter; headers are shown verbatim. */
export const rowText = (row: DiffRow, gutter: DiffGutter): string => {
  if (row.kind === 'header') return row.text;
  const sigil = SIGIL[row.kind];
  return gutter === 'spaced' ? `${sigil} ${row.text}` : `${sigil}${row.text}`;
};

export const rowOfLine = (line: Pick<DiffLine, 'kind' | 'text'>): DiffRow => ({ kind: line.kind, text: line.text });

/** Flattens a parsed diff into rows: `@@` header then body per hunk; a file header row when there are several files. */
export const laneRows = (diff: UnifiedDiff): DiffRow[] => {
  const rows: DiffRow[] = [];
  for (const file of diff.files) {
    if (diff.files.length > 1) rows.push({ kind: 'header', text: file.path });
    for (const hunk of file.hunks) {
      rows.push({ kind: 'header', text: hunk.header });
      for (const line of hunk.lines) rows.push(rowOfLine(line));
    }
  }
  return rows;
};

/**
 * `parseUnifiedDiff` over text without its final line terminator: `git diff` output and `AgentChange.patch`
 * end in `\n`, which the core parser would otherwise read as one extra blank context line.
 */
export const parsePatch = (text: string): UnifiedDiff => parseUnifiedDiff(text.replace(/\n$/, ''));

/** Body rows of an agent change (its patch carries `---`/`+++`/`@@` headers, which are dropped). */
export const changeRows = (change: Pick<AgentChange, 'patch'>): DiffRow[] =>
  parsePatch(change.patch).files.flatMap((f) => f.hunks.flatMap((h) => h.lines.map(rowOfLine)));

/** "@@ -1,2 +1,3 @@" for an agent change. */
export const changeHeader = (c: Pick<AgentChange, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>): string =>
  `@@ -${c.oldStart},${c.oldLines} +${c.newStart},${c.newLines} @@`;
