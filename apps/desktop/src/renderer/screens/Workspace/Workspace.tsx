import {
  AGENT_LABEL,
  copy,
  rows,
  sessionTabs,
  sessionsInProject,
  type AgentChange,
  type ProjectId,
  type ReadModel,
  type SessionId,
  type Worktree,
} from '@styx/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatPane } from '../../features/chat/ChatPane';
import { FilesPane } from '../../features/editor/FilesPane';
import { FileTabs, type FileTab } from '../../features/editor/FileTabs';
import { FIXTURE_DEFAULT_FILE, type FileNode, type GitStatus } from '../../features/editor/fixture-files';
import { loadWorktreeTree } from '../../features/editor/fs-source';
import { HunkBar } from '../../features/editor/HunkBar';
import { hunkBarLabel, hunkMatchesFile, pendingHunksOf } from '../../features/editor/hunk-decorations';
import { MonacoEditor, type FileState } from '../../features/editor/MonacoEditor';
import { editorStatusLabel, statusBarTargets } from '../../features/editor/status-bar';
import { StatusBar } from '../../features/editor/StatusBar';
import { TerminalPane } from '../../features/terminal/TerminalPane';
import { command } from '../../state/commands';
import { useModel, useNow, useSessionId, useUi } from '../../state/hooks';
import { useUiStore } from '../../state/ui-store';
import s from './Workspace.module.css';

/**
 * The worktree the editor column shows: the project's default session tab's worktree (what the titlebar branch
 * reads), else the main worktree.
 */
export const editorWorktree = (model: ReadModel, projectId: ProjectId): Worktree | null => {
  const first = sessionsInProject(model, projectId)
    .filter((x) => x.state !== 'done')
    .sort((a, b) => a.startedAt - b.startedAt)[0];
  const own = first === undefined ? undefined : model.worktrees.byId[first.worktreeId];
  if (own !== undefined) return own;
  return rows(model.worktrees).find((w) => w.projectId === projectId && w.isMain) ?? null;
};

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

  const worktree = projectId === null ? null : editorWorktree(model, projectId);
  // The chat's active tab (falls back to the first tab when no session was picked yet).
  const activeSessionId = projectId === null ? null : sessionTabs(model, projectId, sessionId).activeId;
  const worktreeId = worktree?.id ?? null;
  const changes = useMemo(
    () => (worktreeId === null ? [] : pendingHunksOf(model.hunks, worktreeId)),
    [model.hunks, worktreeId],
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

  const openFile = (path: string) => {
    setOpen((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setEditorFile(path);
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

  const targets = projectId === null ? [] : statusBarTargets(model, projectId, now);
  const editorStatus = editorStatusLabel(fileState?.eol ?? 'lf', fileState?.lang ?? 'TS');
  const screenReader = model.settings.app.screenReader;
  const ide = fallbackIde(model);

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
        <FileTabs tabs={tabs} activePath={activePath} onSelect={openFile} />
        <MonacoEditor
          worktreeId={worktreeId}
          path={activePath}
          changes={changes}
          agentOf={agentOf}
          now={now}
          screenReader={screenReader}
          onFileState={setFileState}
        />
        {changes.length > 0 && hunkAgent !== null && (
          <HunkBar
            label={hunkBarLabel(changes.length, hunkAgent, hunkNote)}
            onAcceptAll={() => {
              for (const id of hunkSessions) void command('hunk.acceptAll', { sessionId: id });
            }}
            onReview={() => setScreen('diff')}
            onRejectAll={() => {
              for (const id of hunkSessions) void command('hunk.rejectAll', { sessionId: id });
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
        <StatusBar branch={branchLabel} targets={targets} editor={editorStatus} />
      </div>
      <ChatPane projectId={projectId} />
    </div>
  );
}
