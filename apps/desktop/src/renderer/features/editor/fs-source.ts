import {
  TREE_MAX_DEPTH,
  type CommandInput,
  type CommandName,
  type CommandOutput,
  type WorktreeId,
} from '@styx/core';
import { bridge } from '../../state/bridge';
import { command } from '../../state/commands';
import {
  FIXTURE_CHANGES,
  FIXTURE_TREE,
  fixtureFileText,
  type FileNode,
  type GitStatus,
} from './fixture-files';

export type FileSource = 'fs' | 'fixture';

/**
 * Read-only query straight over the bridge: a failed read (missing main, worktree not on disk) falls back to the
 * prototype fixture instead of raising the error toast `command()` shows for failed mutations.
 */
const query = async <N extends CommandName>(
  name: N,
  input: CommandInput<N>,
): Promise<CommandOutput<N> | null> => {
  const api = bridge();
  if (api?.command === undefined) return null;
  try {
    const r = await api.command(name, input);
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
};

export interface LoadedFile {
  text: string;
  eol: 'lf' | 'crlf';
  source: FileSource;
  /** Binary or over the size cap: the model is opened read-only. */
  readOnly?: boolean;
  notice?: 'binary' | 'large';
}

/** Over this size a file opens read-only: Monaco tokenises the whole buffer, so a huge file freezes the pane. */
export const MAX_EDITABLE_BYTES = 1024 * 1024;
/** A NUL in the first 8 KB means binary; Monaco would render mojibake and a save would corrupt the file. */
const BINARY_PROBE = 8 * 1024;

export const isBinaryText = (text: string): boolean => text.slice(0, BINARY_PROBE).includes('\u0000');

export const readWorktreeFile = async (worktreeId: WorktreeId, path: string): Promise<LoadedFile> => {
  const r = await query('fs.readFile', { worktreeId, path });
  if (r !== null) {
    if (isBinaryText(r.text)) return { text: '', eol: r.eol, source: 'fs', readOnly: true, notice: 'binary' };
    // A JS string is UTF-16; byte length is what the cap is about, so measure it.
    const bytes = new TextEncoder().encode(r.text).length;
    if (bytes > MAX_EDITABLE_BYTES)
      return { text: r.text, eol: r.eol, source: 'fs', readOnly: true, notice: 'large' };
    return { text: r.text, eol: r.eol, source: 'fs' };
  }
  return { text: fixtureFileText(path), eol: 'lf', source: 'fixture' };
};

export const writeWorktreeFile = (worktreeId: WorktreeId, path: string, text: string): void => {
  void command('fs.writeFile', { worktreeId, path, text });
};

export interface LoadedTree {
  nodes: FileNode[];
  changes: { path: string; status: GitStatus }[];
  source: FileSource;
}

/**
 * The tree comes back from main in one call (discrepancy #115), already ordered and already carrying git
 * marks. This used to walk directory by directory — one IPC round trip and one full `git status` each — which
 * on a real project meant a hundred-odd of both on every project switch, serialised on the main thread.
 */
/** The worktree's tree, or the prototype fixture when main cannot answer (no bridge, worktree gone). */
export const loadWorktreeTree = async (worktreeId: WorktreeId): Promise<LoadedTree> => {
  const r = await query('fs.readTree', { worktreeId, maxDepth: TREE_MAX_DEPTH });
  if (r === null || r.nodes.length === 0) {
    return { nodes: [...FIXTURE_TREE], changes: [...FIXTURE_CHANGES], source: 'fixture' };
  }
  const nodes: FileNode[] = r.nodes.map((n) => ({
    path: n.path,
    name: n.name,
    kind: n.kind,
    depth: n.depth,
    status: n.status,
  }));
  const changes = nodes
    .filter((n): n is FileNode & { status: GitStatus } => n.kind === 'file' && n.status !== null)
    .map((n) => ({ path: n.path, status: n.status }));
  return { nodes, changes, source: 'fs' };
};
