import {
  fill,
  copy,
  fixtures,
  repoHasGit,
  type CommandResult,
  type ReadModel,
  type UnifiedDiff,
  type WorktreeId,
} from '@styx/core';
import { Button, EmptyState, Label, StatusDot, Table, TableCell, TableRow } from '@styx/ui';
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { LaneDiff, parsePatch } from '../../features/diff';
import { bridge, env } from '../../state/bridge';
import { startDebtAudit } from '../../features/audit';
import { command } from '../../state/commands';
import { useModel, useNow, useSessionId, useUi } from '../../state/hooks';
import { useReadModel } from '../../state/read-model';
import {
  defaultLane,
  laneDiffHeader,
  laneRows,
  nextWorktreeBranch,
  noGitLine,
  remoteLine,
  repoOfProject,
  type Lane,
} from './repo-data';
import s from './Repo.module.css';

const identity = (m: ReadModel) => m;
const EMPTY_DIFF: UnifiedDiff = { files: [] };
/**
 * The prototype's `1.2fr 1fr 1.6fr 1fr .7fr` with the action column widened to hold two verbs (`Commit & push ·
 * Open`, ADR-0021) on one line down to the 1100px window minimum; the Changes and PR columns give up the width.
 */
const LANE_COLUMNS = '1.2fr 1fr 1.4fr .9fr 1fr';

/**
 * Read query (not a mutation): asks main for the worktree's `git diff -U3`. Unlike `command()` it never toasts —
 * on the demo fixture the worktree may not exist on disk yet, in which case the prototype's lane diff stands in.
 */
const queryLaneDiff = async (worktreeId: WorktreeId): Promise<string | null> => {
  const api = bridge();
  if (api?.command === undefined) return null;
  try {
    const r: CommandResult<'worktree.diff'> = await api.command('worktree.diff', { worktreeId });
    if (!r.ok) return null;
    if (r.value.diff.trim() === '' && env().fixture !== undefined) return null;
    return r.value.diff;
  } catch {
    return null;
  }
};

/** Diff text of the selected lane; falls back to `fixtures.demoLaneDiff` when main cannot produce one. */
function useLaneDiff(worktreeId: WorktreeId | null): UnifiedDiff {
  const [state, setState] = useState<{ worktreeId: WorktreeId; diff: UnifiedDiff } | null>(null);
  useEffect(() => {
    if (worktreeId === null) return;
    let live = true;
    void queryLaneDiff(worktreeId).then((text) => {
      if (!live) return;
      setState({ worktreeId, diff: parsePatch(text ?? fixtures.demoLaneDiff) });
    });
    return () => {
      live = false;
    };
  }, [worktreeId]);
  if (worktreeId === null) return EMPTY_DIFF;
  return state !== null && state.worktreeId === worktreeId ? state.diff : EMPTY_DIFF;
}

const runAction = (lane: Lane): void => {
  switch (lane.action) {
    case 'open':
      void command('worktree.openInIde', { worktreeId: lane.worktreeId });
      return;
    case 'archive':
      void command('worktree.archive', { worktreeId: lane.worktreeId });
      return;
    case 'resolve':
      // ADR-0025 phase B: Styx finishes the merge with the lane's agent (both sides' intent handed over, checks
      // run, then committed); the editor stays one click away for whoever wants to look.
      void command('worktree.resolve', { worktreeId: lane.worktreeId });
      return;
    case 'undo-merge':
      void command('worktree.undoResolve', { worktreeId: lane.worktreeId });
      return;
    case 'undo-land':
      void command('worktree.undoLand', { worktreeId: lane.worktreeId });
      return;
    case 'diff':
      return;
  }
};

/** Repo (spec §4.4): worktree lanes with the selected lane's unified diff below. */
export function Repo() {
  const model = useModel(identity);
  const now = useNow();
  const projectId = useUi((u) => u.projectId);
  const activeSessionId = useSessionId();
  const lanes = useMemo(
    () => (projectId === null ? [] : laneRows(model, projectId, now)),
    [model, projectId, now],
  );
  const repo = projectId === null ? null : repoOfProject(model, projectId);
  const hasGit = repoHasGit(repo);
  const [pickedId, setPickedId] = useState<WorktreeId | null>(null);
  const selected =
    (pickedId === null ? undefined : lanes.find((l) => l.worktreeId === pickedId)) ??
    defaultLane(lanes, activeSessionId);
  const diff = useLaneDiff(hasGit ? (selected?.worktreeId ?? null) : null);

  const fetch = useCallback(() => {
    if (projectId !== null) void command('worktree.fetch', { projectId });
  }, [projectId]);
  /** Starts the debt audit as a background task. */
  const audit = useCallback(() => {
    if (projectId === null) return;
    const m = useReadModel.getState().model;
    void startDebtAudit(m, projectId);
  }, [projectId]);

  const create = useCallback(() => {
    if (projectId === null) return;
    const m = useReadModel.getState().model;
    const base = repoOfProject(m, projectId)?.defaultBranch ?? 'main';
    void command('worktree.create', { projectId, branch: nextWorktreeBranch(m, projectId), base });
  }, [projectId]);

  const onAction = (lane: Lane) => (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (lane.action === 'diff' || lane.action === 'resolve') setPickedId(lane.worktreeId);
    runAction(lane);
  };
  const pushOverlay = useUi((u) => u.pushOverlay);
  /** Commit, push and PR in one step for the lane (ADR-0021); the store hands focus back to the button on close. */
  const onPublish = (lane: Lane) => (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    pushOverlay({ kind: 'modal', modal: 'publish', worktreeId: lane.worktreeId });
  };
  /** Land the lane into the base (ADR-0025 phase C): summary drafted by the agent, checks, merge, push, Undo. */
  const onLand = (lane: Lane) => (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    pushOverlay({ kind: 'modal', modal: 'land', worktreeId: lane.worktreeId });
  };
  const onOpenPr = (lane: Lane) => (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (lane.prUrl !== null) void command('link.open', { url: lane.prUrl });
  };

  // Plain folder (owner decision: any folder is a project): no lanes, no diff — the empty state offers `git init`.
  if (projectId !== null && !hasGit) {
    return (
      <div className={s['screen']} data-repo="true" data-repo-empty="no-git">
        <div className={s['head']}>
          <span className={s['title']}>{copy.repo.title}</span>
          <span className={s['meta']} data-repo-remote="true">
            {noGitLine()}
          </span>
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
    <div className={s['screen']} data-repo="true">
      <div className={s['head']}>
        <span className={s['title']}>{copy.repo.title}</span>
        <span className={s['meta']} data-repo-remote="true">
          {remoteLine(repo)}
        </span>
        {/* No remote: Publish and Land have nowhere to push until one is connected; with one, it can be replaced
            (owner report and request). */}
        {projectId !== null && repo !== null ? (
          <Button
            size="regular"
            variant={repo.remotes.length === 0 ? 'secondary' : 'ghost'}
            onClick={() => pushOverlay({ kind: 'modal', modal: 'connect-repo', projectId })}
            data-repo-connect={repo.remotes.length === 0 ? 'connect' : 'reconnect'}
          >
            {repo.remotes.length === 0 ? copy.repo.connect : copy.repo.reconnect}
          </Button>
        ) : null}
        <span className={s['spacer']} />
        <Button size="regular" onClick={audit} data-repo-audit="true">
          {copy.debtAudit.action}
        </Button>
        <Button size="regular" onClick={fetch}>
          {copy.repo.fetch}
        </Button>
        <Button size="regular" variant="primary" onClick={create}>
          {copy.repo.addWorktree}
        </Button>
      </div>
      <Table
        className={s['lanes']}
        columns={LANE_COLUMNS}
        header={[
          copy.repo.columns.branch,
          copy.repo.columns.owner,
          copy.repo.columns.changes,
          copy.repo.columns.pr,
          '',
        ]}
        aria-label={copy.repo.title}
      >
        {lanes.map((lane) => {
          const inv = selected?.worktreeId === lane.worktreeId;
          return (
            <TableRow
              key={lane.worktreeId}
              inv={inv}
              aria-selected={inv}
              onActivate={() => setPickedId(lane.worktreeId)}
              data-lane={lane.branch}
            >
              <TableCell className={s['branch']}>{lane.branch}</TableCell>
              <TableCell>
                <StatusDot size={7} tone={lane.dot} />
                {lane.owner}
              </TableCell>
              <TableCell mono>
                {lane.changes}
                {lane.sync !== null ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className={s['syncAction']}
                      title={lane.sync.label}
                      aria-label={`${lane.sync.label} · ${lane.branch}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void command('worktree.sync', { worktreeId: lane.worktreeId });
                      }}
                      data-action="sync"
                    >
                      {fill(copy.repo.changes.behind, { n: lane.sync.n, base: lane.sync.base })}
                    </button>
                  </>
                ) : null}
                {lane.overlaps !== null ? (
                  <>
                    {' '}
                    <span
                      className={s['overlapTag']}
                      title={fill(copy.lanes.tagTitle, { files: lane.overlaps.files.join(', ') })}
                      data-lane-overlaps={lane.overlaps.branches.join(' ')}
                    >
                      {lane.overlaps.branches.map((b) => fill(copy.lanes.tag, { branch: b })).join(' · ')}
                    </span>
                  </>
                ) : null}
              </TableCell>
              <TableCell mono>
                {lane.prUrl !== null ? (
                  <button type="button" className={s['prLink']} onClick={onOpenPr(lane)} data-lane-pr="true">
                    {lane.pr}
                  </button>
                ) : (
                  lane.pr
                )}
              </TableCell>
              <TableCell label align="end" className={s['actions']}>
                {lane.publishLabel !== null ? (
                  <button
                    type="button"
                    className={s['action']}
                    onClick={onPublish(lane)}
                    data-action="publish"
                  >
                    {lane.publishLabel}
                  </button>
                ) : null}
                {lane.landLabel !== null ? (
                  <button type="button" className={s['action']} onClick={onLand(lane)} data-action="land">
                    {lane.landLabel}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={s['action']}
                  onClick={onAction(lane)}
                  data-action={lane.action}
                >
                  {lane.actionLabel}
                </button>
              </TableCell>
            </TableRow>
          );
        })}
      </Table>
      {selected !== null && selected !== undefined ? (
        <>
          <Label as="div" className={s['diffHead']} data-lane-diff-head="true">
            {laneDiffHeader(selected.branch, diff)}
          </Label>
          <LaneDiff diff={diff} role="region" aria-label={selected.branch} />
        </>
      ) : null}
    </div>
  );
}
