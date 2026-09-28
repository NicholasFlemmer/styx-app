import {
  AGENT_LABEL,
  copy,
  projectWorktreeOf,
  rows,
  sessionTabs,
  type AgentChange,
  type ProjectId,
  type ReadModel,
  type SessionId,
  type Worktree,
  SUPPORT_URL,
} from '@styx/core';
import { Tab } from '@styx/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatPane } from '../../features/chat/ChatPane';
import { FilesPane } from '../../features/editor/FilesPane';
import { DesignPane } from '../../features/preview';
import { FileTabs, type FileTab } from '../../features/editor/FileTabs';
import { FIXTURE_DEFAULT_FILE, type FileNode, type GitStatus } from '../../features/editor/fixture-files';
import { loadWorktreeTree } from '../../features/editor/fs-source';
import { HunkBar } from '../../features/editor/HunkBar';
import { hunkBarLabel, hunkMatchesFile, pendingHunksOf } from '../../features/editor/hunk-decorations';
import {
  MonacoEditor,
  WORD_WRAP_KEY,
  applyWordWrap,
  type FileState,
} from '../../features/editor/MonacoEditor';
import {
  editorReadoutItems,
  editorStatusLabel,
  statusBarDeploy,
  statusBarDevice,
  statusBarLane,
  statusBarRun,
  statusBarTargets,
} from '../../features/editor/status-bar';
import { DeployButton } from '../../features/workspace/DeployButton';
import { LandButton } from '../../features/workspace/LandButton';
import { PublishButton } from '../../features/workspace/PublishButton';
import { StatusBar } from '../../features/editor/StatusBar';
import { TerminalPane } from '../../features/terminal/TerminalPane';
import { onEvent } from '../../state/bridge';
import { command } from '../../state/commands';
import { useModel, useNow, useSessionId, useUi } from '../../state/hooks';
import { useUiStore } from '../../state/ui-store';
import s from './Workspace.module.css';

/** Which half of the editor column is showing; persisted alongside the pane sizes. */
const WORKSPACE_MODE_KEY = 'workspace-mode';
/** git needs a moment after a turn ends before its marks are final; one re-read, not one per delta. */
const TREE_REFRESH_DEBOUNCE_MS = 400;

/**
 * The worktree the editor column shows: the active chat tab's lane (files, terminal, status bar and Run locally
 * all follow the tab the person is on), else the project's default session tab's worktree (what the nav branch
 * reads), else the main worktree.
 */
export const editorWorktree = (
  model: ReadModel,
  projectId: ProjectId,
  activeSessionId: SessionId | null = null,
): Worktree | null => projectWorktreeOf(model, projectId, activeSessionId);

const fallbackIde = (model: ReadModel): string | null => {
  const ides = model.discovery.ides;
  const ide =
    ides.find((i) => i.isFallback) ?? ides.find((i) => i.kind === model.settings.app.fallbackIde) ?? null;
  return ide?.product ?? null;
};

/** Files with pending agent hunks that git reports as newly added are agent-authored → agent Tag on the tab. */
const fileTabs = (
  open: readonly string[],
  nodes: readonly FileNode[],
  changes: readonly AgentChange[],
  agentOf: (id: SessionId) => string,
): FileTab[] =>
  open.map((path) => {
    const node = nodes.find((n) => n.path === path);
    const hunk = changes.find((h) => h.status === 'pending' && hunkMatchesFile(h, path));
    return { path, agent: node?.status === 'A' && hunk !== undefined ? agentOf(hunk.sessionId) : null };
  });

interface Tree {
  nodes: FileNode[];
  changes: { path: string; status: GitStatus }[];
}

/** Workspace (spec §4.1): files 200 · editor stack · chat 360; the grant sheet slides over the chat pane. */
export function Workspace() {
  const projectId = useUi((u) => u.projectId);
  const sessionId = useSessionId();
  const editorFile = useUi((u) => u.editorFile);
  const setEditorFile = useUi((u) => u.setEditorFile);
  const setScreen = useUi((u) => u.setScreen);
  const model = useModel(useCallback((m: ReadModel) => m, []));
  const now = useNow();
  const column = useRef<HTMLDivElement>(null);

  // The chat's active tab (falls back to the first tab when no session was picked yet).
  const activeSessionId = projectId === null ? null : sessionTabs(model, projectId, sessionId).activeId;
  const worktree = projectId === null ? null : editorWorktree(model, projectId, activeSessionId);
  const worktreeId = worktree?.id ?? null;
  // Tracking off (the default): no bands, no hunk bar — main sends no hunks either, but a stale row must not show.
  const tracking = model.settings.app.trackAgentEdits;
  const changes = useMemo(
    () => (worktreeId === null || !tracking ? [] : pendingHunksOf(model.hunks, worktreeId)),
    [model.hunks, worktreeId, tracking],
  );
  const agentOf = useCallback(
    (id: SessionId) => {
      const sess = model.sessions.byId[id];
      return sess === undefined ? copy.general.none : AGENT_LABEL[sess.agent];
    },
    [model.sessions],
  );

  const [tree, setTree] = useState<Tree>({ nodes: [], changes: [] });
  const [open, setOpen] = useState<string[]>([]);
  const [fileState, setFileState] = useState<FileState | null>(null);

  // Tree per worktree; the changed files start out as the open tabs (prototype: checkout.ts · pay.ts · validate.ts).
  useEffect(() => {
    if (worktreeId === null) return;
    let cancelled = false;
    void loadWorktreeTree(worktreeId).then((t) => {
      if (cancelled) return;
      setTree({ nodes: t.nodes, changes: t.changes });
      const initial = t.changes.map((c) => c.path);
      setOpen(initial);
      const current = useUiStore.getState().editorFile;
      if (current === null || !t.nodes.some((n) => n.path === current)) {
        setEditorFile(initial[0] ?? (t.source === 'fixture' ? FIXTURE_DEFAULT_FILE : null));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [worktreeId, setEditorFile]);

  // The tree is read again when the lane's files may have moved: a session on it changed state (a turn ended, an
  // approval was answered), a checkpoint was recorded, the hunk watcher saw something, or the window came back
  // to the front (the person edited in another app). Only the nodes and marks change: open tabs and the file in
  // the editor stay as they were. Without this an agent's new file only showed after leaving the Workspace.
  const treeStamp = useMemo(() => {
    if (worktreeId === null) return '';
    const parts: string[] = [String(changes.length)];
    for (const sess of rows(model.sessions))
      if (sess.worktreeId === worktreeId && sess.archivedAt === null)
        parts.push(`${sess.id}:${sess.state}:${(model.checkpoints[sess.id] ?? []).length}`);
    return parts.join('|');
  }, [worktreeId, changes.length, model.sessions, model.checkpoints]);
  const lastStamp = useRef(treeStamp);
  const refreshTree = useCallback(() => {
    if (worktreeId === null) return;
    void loadWorktreeTree(worktreeId).then((t) => {
      if (t.source !== 'fs') return;
      setTree({ nodes: t.nodes, changes: t.changes });
    });
  }, [worktreeId]);
  useEffect(() => {
    if (lastStamp.current === treeStamp) return;
    lastStamp.current = treeStamp;
    const timer = setTimeout(refreshTree, TREE_REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [treeStamp, refreshTree]);
  useEffect(() => {
    window.addEventListener('focus', refreshTree);
    return () => window.removeEventListener('focus', refreshTree);
  }, [refreshTree]);
  // And the disk itself: main watches the worktree the pane shows and says when anything under it moved.
  useEffect(() => {
    if (worktreeId === null) return;
    void command('fs.watchTree', { worktreeId });
    const off = onEvent('fs.treeChanged', (e) => {
      if (e.worktreeId === worktreeId) refreshTree();
    });
    return () => {
      off();
      void command('fs.unwatchTree', {});
    };
  }, [worktreeId, refreshTree]);

  const openFile = (path: string) => {
    setOpen((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setEditorFile(path);
  };

  /** Closing the current file falls back to its neighbour, so the editor never lands on nothing while tabs remain. */
  const closeFile = (path: string) => {
    setOpen((prev) => {
      const next = prev.filter((p) => p !== path);
      if (editorFile === path) {
        const at = prev.indexOf(path);
        setEditorFile(next[Math.min(at, next.length - 1)] ?? null);
      }
      return next;
    });
  };

  const tabs = useMemo(
    () => fileTabs(open, tree.nodes, changes, agentOf),
    [open, tree.nodes, changes, agentOf],
  );
  const activePath = editorFile !== null && open.includes(editorFile) ? editorFile : (open[0] ?? null);

  const hunkSessions = useMemo(() => [...new Set(changes.map((h) => h.sessionId))], [changes]);
  const hunkAgent = hunkSessions[0] === undefined ? null : agentOf(hunkSessions[0]);
  const hunkNote =
    hunkSessions[0] === undefined ? null : (model.sessions.byId[hunkSessions[0]]?.note ?? null);

  const targets =
    projectId === null
      ? []
      : [
          ...statusBarTargets(model, projectId, now),
          ...statusBarLane(model, projectId, worktreeId),
          ...statusBarRun(model.runs[projectId] ?? null),
          ...statusBarDevice(model.devices[projectId] ?? null),
          ...statusBarDeploy(model, projectId),
        ];
  const editorStatus = editorStatusLabel(fileState?.eol ?? 'lf', fileState?.lang ?? 'TS');
  // Right of the prototype's `Monaco · LF · TS`: caret, wrap and any read-only notice (discrepancies #58).
  const editorExtras =
    fileState === null
      ? []
      : editorReadoutItems({ cursor: fileState.cursor, wrap: fileState.wrap, readOnly: fileState.readOnly });
  const screenReader = model.settings.app.screenReader;
  const setPaneSize = useUi((u) => u.setPaneSize);
  const wrapPref = useUi((u) => u.paneSizes[WORD_WRAP_KEY] ?? 0);
  useEffect(() => {
    applyWordWrap(wrapPref === 1);
  }, [wrapPref]);
  const ide = fallbackIde(model);
  // Code / Design lives in the ui store's pane sizes so it survives a screen switch like the other pane prefs.
  const modePref = useUi((u) => u.paneSizes[WORKSPACE_MODE_KEY] ?? 0);
  const mode: 'code' | 'design' = modePref === 1 ? 'design' : 'code';
  const setMode = (next: 'code' | 'design') => {
    setPaneSize(WORKSPACE_MODE_KEY, next === 'design' ? 1 : 0);
    void command('ui.persist', { paneSizes: { [WORKSPACE_MODE_KEY]: next === 'design' ? 1 : 0 } });
  };
  const devUrl = projectId === null ? null : (model.settings.project[projectId]?.devUrl.value ?? null);

  if (projectId === null || worktree === null || worktreeId === null) {
    return (
      <div className={s['root']} data-workspace="empty">
        <span className={['t-label', s['empty']].join(' ')}>{copy.empty.noProject}</span>
      </div>
    );
  }

  // Plain folder (no git): the main worktree is the folder itself, no branch, no hunks; status bar reads `no git`.
  const branchLabel = worktree.branch ?? copy.workspace.noGit;

  return (
    <div className={s['root']} data-workspace={worktree.branch ?? 'no-git'}>
      <FilesPane
        nodes={tree.nodes}
        activePath={activePath}
        onOpen={openFile}
        changes={tree.changes}
        ideName={ide}
        onOpenInIde={() =>
          void command(
            'worktree.openInIde',
            activePath === null ? { worktreeId } : { worktreeId, file: activePath },
          )
        }
      />
      <div ref={column} className={s['column']}>
        {/*
          Code / Design share the editor column rather than splitting it: the design window needs the full width
          to be worth having at tablet and desktop sizes, and the owner ranks it above the editor.
        */}
        <div className={s['modes']}>
          <div className={s['tabs']} role="tablist" aria-label={copy.workspace.design.design}>
            <Tab
              variant="approvals"
              label={copy.workspace.design.code}
              inv={mode === 'code'}
              onClick={() => setMode('code')}
              data-workspace-mode="code"
            />
            <Tab
              variant="approvals"
              label={copy.workspace.design.design}
              inv={mode === 'design'}
              onClick={() => setMode('design')}
              data-workspace-mode="design"
            />
          </div>
          <LandButton projectId={projectId} />
          <PublishButton projectId={projectId} />
          <DeployButton projectId={projectId} />
        </div>
        {mode === 'design' ? (
          <DesignPane
            projectId={projectId}
            worktreeId={worktreeId}
            devUrl={devUrl}
            active
            run={model.runs[projectId] ?? null}
            devCommand={model.settings.project[projectId]?.devCommand.value ?? null}
            device={model.devices[projectId] ?? null}
            devPlatform={model.settings.project[projectId]?.devPlatform.value ?? null}
            devDevice={model.settings.project[projectId]?.devDevice.value ?? null}
          />
        ) : (
          <>
            <FileTabs tabs={tabs} activePath={activePath} onSelect={openFile} onClose={closeFile} />
            <MonacoEditor
              worktreeId={worktreeId}
              path={activePath}
              changes={changes}
              agentOf={agentOf}
              now={now}
              screenReader={screenReader}
              onFileState={setFileState}
              onWordWrap={(on) => setPaneSize(WORD_WRAP_KEY, on ? 1 : 0)}
            />
          </>
        )}
        {changes.length > 0 && hunkAgent !== null && (
          <HunkBar
            label={hunkBarLabel(changes.length, hunkAgent, hunkNote)}
            onReview={() => setScreen('diff')}
            onRevertAll={() => {
              for (const id of hunkSessions) void command('hunk.revertAll', { sessionId: id });
            }}
            onMarkReviewed={() => {
              for (const id of hunkSessions) void command('hunk.done', { sessionId: id });
            }}
          />
        )}
        {/* Before the first spawn the terminal belongs to the worktree itself (a shell in the project folder). */}
        <TerminalPane
          sessionId={activeSessionId}
          worktreeId={worktreeId}
          branch={branchLabel}
          screenReader={screenReader}
          columnHeight={() => column.current?.clientHeight ?? 0}
        />
        <StatusBar
          branch={branchLabel}
          targets={targets}
          editor={editorStatus}
          extras={editorExtras}
          feedback={{
            label: copy.feedback.status,
            title: copy.feedback.statusTitle,
            onOpen: () => useUiStore.getState().pushOverlay({ kind: 'modal', modal: 'feedback' }),
          }}
          support={{
            label: copy.support.label,
            title: copy.support.title,
            onOpen: () => void command('link.open', { url: SUPPORT_URL }),
          }}
        />
      </div>
      <ChatPane projectId={projectId} />
    </div>
  );
}
