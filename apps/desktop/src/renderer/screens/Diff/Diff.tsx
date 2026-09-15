import { copy, fill, projectHasGit, type ReadModel } from '@styx/core';
import { sizes } from '@styx/tokens';
import { Button, EmptyState, Label, Tag } from '@styx/ui';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { DiffBlock } from '../../features/diff';
import { diffBindings, keys } from '../../keys';
import { command } from '../../state/commands';
import { useModel, useSessionId, useUi } from '../../state/hooks';
import { useReadModel } from '../../state/read-model';
import { selectSessionId, useUiStore } from '../../state/ui-store';
import { clampFocus, modLabel, reviewOf, type Review, type ReviewHunk } from './diff-data';

/** The review as of now (for key handlers, which must not close over a render). */
const currentReview = (): Review => {
  const ui = useUiStore.getState();
  return reviewOf(useReadModel.getState().model, ui.projectId, selectSessionId(ui));
};
import s from './Diff.module.css';

const identity = (m: ReadModel) => m;

/**
 * One hunk: file · range · status tag (applied / reverted / reviewed; `data-on` once reverted) · a single Revert
 * button (inverted once reverted, enabled only while pending). The agent already applied the edit, so there is no
 * Accept (owner decision, replaces spec §4.7).
 */
function HunkView({
  hunk,
  index,
  setEl,
}: {
  hunk: ReviewHunk;
  index: number;
  setEl: (el: HTMLElement | null) => void;
}) {
  const reverted = hunk.status === 'rejected';
  return (
    <article
      ref={setEl}
      role="listitem"
      className={s['hunk']}
      tabIndex={-1}
      aria-label={`${hunk.file} ${hunk.range}`}
      data-hunk={hunk.id}
      data-status={hunk.status}
      onFocus={() => useUiStore.getState().setDiffFocusIndex(index)}
    >
      <div className={s['hunkHead']}>
        <span>{hunk.file}</span>
        <span className={s['range']}>{hunk.range}</span>
        <span className={s['spacer']} />
        <Tag size="md" on={reverted} className={s['status']} data-hunk-status="true">
          {copy.diff.status[hunk.status]}
        </Tag>
        <Button
          size="hunk"
          inv={reverted}
          disabled={hunk.status !== 'pending'}
          className={s['hunkButton']}
          onClick={() => void command('hunk.revert', { hunkId: hunk.id })}
        >
          {copy.diff.revert}
        </Button>
      </div>
      <DiffBlock rows={hunk.rows} gutter="spaced" />
    </article>
  );
}

/**
 * Diff review: r / j / k / Mod+⏎ in scope `diff`. The agent already applied its edits, so review = look, revert,
 * mark reviewed; Done marks the pending hunks reviewed (`hunk.done`) and returns to the Workspace.
 */
export function Diff() {
  const model = useModel(identity);
  const projectId = useUi((u) => u.projectId);
  const activeSessionId = useSessionId();
  const platform = useUi((u) => u.platform);
  const review = useMemo(() => reviewOf(model, projectId, activeSessionId), [model, projectId, activeSessionId]);

  const root = useRef<HTMLDivElement>(null);
  const hunkEls = useRef<(HTMLElement | null)[]>([]);

  // Plain-key chords resolve from the focused element's scope, so the screen takes focus on mount.
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const ui = useUiStore.getState();
    const clamped = clampFocus(ui.diffFocusIndex, review.hunks.length);
    if (clamped !== ui.diffFocusIndex) ui.setDiffFocusIndex(clamped);
  }, [review.hunks.length]);

  const move = useCallback((delta: number) => {
    const ui = useUiStore.getState();
    const count = currentReview().hunks.length;
    if (count === 0) return;
    const next = clampFocus(ui.diffFocusIndex + delta, count);
    ui.setDiffFocusIndex(next);
    const el = hunkEls.current[next];
    if (el === null || el === undefined) return;
    el.focus({ preventScroll: true });
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, []);

  /** `r`: revert the focused hunk; a hunk that is no longer pending is left alone (main would refuse anyway). */
  const revert = useCallback(() => {
    const hunk = currentReview().hunks[useUiStore.getState().diffFocusIndex];
    if (hunk === undefined || hunk.status !== 'pending') return;
    void command('hunk.revert', { hunkId: hunk.id });
  }, []);

  const done = useCallback(() => {
    const sessionId = currentReview().sessionId;
    if (sessionId === null) {
      useUiStore.getState().setScreen('workspace');
      return;
    }
    void command('hunk.done', { sessionId }).then((r) => {
      if (r.ok) useUiStore.getState().setScreen('workspace');
    });
  }, []);

  useEffect(
    () =>
      keys.registerAll(
        diffBindings({
          revert,
          next: () => move(1),
          prev: () => move(-1),
          done,
        }),
      ),
    [revert, move, done],
  );

  const revertAll = () => {
    const sessionId = currentReview().sessionId;
    if (sessionId !== null) void command('hunk.revertAll', { sessionId });
  };

  // Plain folder (no git): nothing to review until `git init`; Done still returns to the Workspace.
  if (projectId !== null && !projectHasGit(model, projectId)) {
    return (
      <div ref={root} className={s['screen']} tabIndex={-1} data-keyscope="diff" data-diff-review="true" data-diff-empty="no-git">
        <div className={s['head']}>
          <span className={s['title']}>{copy.diff.title}</span>
          <span className={s['meta']} data-diff-meta="true">
            {copy.workspace.noGit}
          </span>
          <span className={s['spacer']} />
          <Button size="regular" variant="primary" onClick={done}>
            {copy.diff.done}
          </Button>
        </div>
        <EmptyState
          headline={copy.repo.noGit.label}
          body={copy.repo.noGit.body}
          actions={
            <Button variant="primary" onClick={() => void command('project.gitInit', { projectId })}>
              {copy.repo.noGit.cta}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div ref={root} className={s['screen']} tabIndex={-1} data-keyscope="diff" data-diff-review="true">
      <div className={s['head']}>
        <span className={s['title']}>{copy.diff.title}</span>
        <span className={s['meta']} data-diff-meta="true">
          {review.meta}
        </span>
        <span className={s['spacer']} />
        <Button size="regular" onClick={revertAll}>
          {copy.diff.revertAll}
        </Button>
        <Button size="regular" variant="primary" onClick={done}>
          {copy.diff.done}
        </Button>
      </div>
      <div className={s['body']}>
        <aside className={s['files']} style={{ width: sizes.diffFilesPane }} aria-label={copy.diff.files.split(' ')[0]}>
          <Label as="div" className={s['filesLabel']}>
            {fill(copy.diff.files, { n: review.files.length })}
          </Label>
          {review.files.map((f) => (
            <div key={f.file} className={s['file']} data-file={f.file}>
              <span>{f.file}</span>
              <span className={s['count']}>+{f.added}</span>
            </div>
          ))}
          <Label as="div" className={s['keysLabel']}>
            {copy.diff.keys.title}
          </Label>
          <div className={s['legend']} data-diff-keys="true">
            {copy.diff.keys.revert}
            <br />
            {copy.diff.keys.nextPrev}
            <br />
            {fill(copy.diff.keys.done, { mod: modLabel(platform) })}
          </div>
        </aside>
        <div className={s['list']} role="list" aria-label={copy.diff.title}>
          {review.hunks.map((hunk, i) => (
            <HunkView
              key={hunk.id}
              hunk={hunk}
              index={i}
              setEl={(el) => {
                hunkEls.current[i] = el;
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
