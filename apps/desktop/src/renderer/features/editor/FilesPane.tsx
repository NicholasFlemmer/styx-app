import { copy, fill } from '@styx/core';
import { Button, Label } from '@styx/ui';
import type { FileNode, GitStatus } from './fixture-files';
import s from './FilesPane.module.css';

/** Tree marks (prototype): modified files carry ●, new files A; deleted / untracked keep their letter. */
export const treeMark = (status: GitStatus | null): string =>
  status === null ? '' : status === 'M' ? '●' : status;

export interface FilesPaneProps {
  nodes: readonly FileNode[];
  activePath: string | null;
  onOpen: (path: string) => void;
  changes: readonly { path: string; status: GitStatus }[];
  /** Fallback IDE product name ("VS Code"); null hides the footer button. */
  ideName: string | null;
  onOpenInIde: () => void;
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Files pane (spec §4.1, 200px): tree with marks, `Changes · n`, footer `Open in {IDE}`. */
export function FilesPane({ nodes, activePath, onOpen, changes, ideName, onOpenInIde }: FilesPaneProps) {
  return (
    <aside className={s['pane']} aria-label={copy.workspace.files} data-files-pane="true">
      <Label as="div" className={s['head']}>
        {copy.workspace.files}
      </Label>
      <div className={s['tree']} role="tree" aria-label={copy.workspace.files}>
        {nodes.map((n) => {
          const current = n.kind === 'file' && n.path === activePath;
          const label = n.kind === 'dir' ? `${n.name}/` : n.name;
          return (
            <div
              key={n.path}
              role="treeitem"
              aria-selected={current}
              tabIndex={n.kind === 'file' ? 0 : -1}
              className={s['row']}
              data-inv={current ? 'true' : undefined}
              data-path={n.path}
              onClick={() => {
                if (n.kind === 'file') onOpen(n.path);
              }}
              onKeyDown={(e) => {
                if (n.kind === 'file' && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onOpen(n.path);
                }
              }}
            >
              <span style={{ paddingLeft: n.depth * 12 }}>{label}</span>
              <span className={s['mark']} data-muted={current ? 'true' : undefined}>
                {treeMark(n.status)}
              </span>
            </div>
          );
        })}
      </div>
      <Label as="div" className={s['changesHead']}>
        {fill(copy.diff.changesHeader, { n: changes.length })}
      </Label>
      {changes.map((c) => (
        <button
          key={c.path}
          type="button"
          className={s['change']}
          data-path={c.path}
          onClick={() => onOpen(c.path)}
        >
          <span className={c.status === 'M' ? s['statusMuted'] : s['statusAccent']}>{c.status}</span>
          {basename(c.path)}
        </button>
      ))}
      <span className={s['spacer']} />
      {ideName !== null && (
        <Button size="regular" className={s['openIn']} onClick={onOpenInIde}>
          {fill(copy.workspace.openIn, { ide: ideName })}
        </Button>
      )}
    </aside>
  );
}
