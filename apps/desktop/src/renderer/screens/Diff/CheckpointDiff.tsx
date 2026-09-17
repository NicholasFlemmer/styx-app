import { agentLabel, branchOf, copy, fill, type Checkpoint, type ReadModel } from '@styx/core';
import { sizes } from '@styx/tokens';
import { Button, EmptyState, Label } from '@styx/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiffBlock, parsePatch, rowOfLine, type DiffRow } from '../../features/diff';
import { diffBindings, keys } from '../../keys';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import { useUiStore } from '../../state/ui-store';
import { modLabel } from './diff-data';
import s from './Diff.module.css';

const identity = (m: ReadModel) => m;
const noop = () => undefined;

export const checkpointOf = (model: ReadModel, checkpointId: string): Checkpoint | null => {
  for (const rows of Object.values(model.checkpoints)) {
    const c = rows.find((r) => r.id === checkpointId);
    if (c !== undefined) return c;
  }
  return null;
};

/** `Turn 3 · 2 files · +40 −8` */
export const checkpointSummary = (c: Pick<Checkpoint, 'turn' | 'files' | 'added' | 'removed'>): string =>
  `${fill(copy.checkpoints.turn, { n: c.turn })} · ${fill(copy.checkpoints.changes, c)}`;

interface PatchFile {
  path: string;
  added: number;
  removed: number;
  rows: DiffRow[];
}

/** One block per file: `@@` header rows then the body, as the review hunks render them. */
export const patchFiles = (patch: string): PatchFile[] =>
  parsePatch(patch).files.map((f) => ({
    path: f.path,
    added: f.added,
    removed: f.removed,
    rows: f.hunks.flatMap((h) => [{ kind: 'header' as const, text: h.header }, ...h.lines.map(rowOfLine)]),
  }));

/**
 * Diff screen, checkpoint mode (ADR-0020): the turn's patch (`checkpoint.diff`), read-only, in the review
 * screen's own clothes — header · files pane · one block per file. Done returns to the Workspace and leaves the
 * mode; so does unmounting, so the hunk bar's Review never lands here by accident.
 */
export function CheckpointDiff({ checkpointId }: { checkpointId: string }) {
  const model = useModel(identity);
  const platform = useUi((u) => u.platform);
  const checkpoint = useMemo(() => checkpointOf(model, checkpointId), [model, checkpointId]);
  const session = checkpoint === null ? undefined : model.sessions.byId[checkpoint.sessionId];
  // The fetched patch, keyed to its checkpoint so a stale answer never shows for another turn.
  const [fetched, setFetched] = useState<{ id: string; patch: string | null; error: string | null } | null>(
    null,
  );
  const patch = fetched?.id === checkpointId ? fetched.patch : null;
  const error = fetched?.id === checkpointId ? fetched.error : null;
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => () => useUiStore.getState().setDiffCheckpoint(null), []);

  useEffect(() => {
    let live = true;
    void command('checkpoint.diff', { checkpointId }).then((r) => {
      if (!live) return;
      setFetched(
        r.ok
          ? { id: checkpointId, patch: r.value.patch, error: null }
          : { id: checkpointId, patch: null, error: r.error.message },
      );
    });
    return () => {
      live = false;
    };
  }, [checkpointId]);

  const files = useMemo(() => (patch === null ? [] : patchFiles(patch)), [patch]);

  const done = useCallback(() => {
    const ui = useUiStore.getState();
    ui.setDiffCheckpoint(null);
    ui.setScreen('workspace');
  }, []);
  useEffect(() => keys.registerAll(diffBindings({ revert: noop, next: noop, prev: noop, done })), [done]);

  const agent = session === undefined ? copy.general.none : agentLabel(session);
  const branch = session === undefined ? copy.general.none : branchOf(model, session);
  const meta =
    checkpoint === null
      ? copy.general.none
      : fill(copy.diff.meta, { agent, branch, summary: checkpointSummary(checkpoint) });

  return (
    <div
      ref={root}
      className={s['screen']}
      tabIndex={-1}
      data-keyscope="diff"
      data-diff-review="true"
      data-diff-checkpoint={checkpointId}
    >
      <div className={s['head']}>
        <span className={s['title']}>{copy.diff.title}</span>
        <span className={s['meta']} data-diff-meta="true">
          {meta}
        </span>
        <span className={s['spacer']} />
        <Button size="regular" variant="primary" onClick={done}>
          {copy.diff.done}
        </Button>
      </div>
      {error !== null ? (
        <EmptyState headline={copy.checkpoints.noChanges} body={error} />
      ) : (
        <div className={s['body']}>
          <aside
            className={s['files']}
            style={{ width: sizes.diffFilesPane }}
            aria-label={copy.diff.files.split(' ')[0]}
          >
            <Label as="div" className={s['filesLabel']}>
              {fill(copy.diff.files, { n: files.length })}
            </Label>
            {files.map((f) => (
              <div key={f.path} className={s['file']} data-file={f.path}>
                <span>{f.path}</span>
                <span className={s['count']}>
                  +{f.added} −{f.removed}
                </span>
              </div>
            ))}
            <Label as="div" className={s['keysLabel']}>
              {copy.diff.keys.title}
            </Label>
            <div className={s['legend']} data-diff-keys="true">
              {fill(copy.diff.keys.done, { mod: modLabel(platform) })}
            </div>
          </aside>
          <div className={s['list']} role="list" aria-label={copy.diff.title}>
            {patch !== null && files.length === 0 && <EmptyState headline={copy.checkpoints.noChanges} />}
            {files.map((f) => (
              <article
                key={f.path}
                role="listitem"
                className={s['hunk']}
                aria-label={f.path}
                data-patch-file={f.path}
              >
                <div className={s['hunkHead']}>
                  <span>{f.path}</span>
                  <span className={s['range']}>
                    +{f.added} −{f.removed}
                  </span>
                </div>
                <DiffBlock rows={f.rows} gutter="spaced" />
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
