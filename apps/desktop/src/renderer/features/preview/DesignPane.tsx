import { openTask } from '../tasks/task-launch';
import {
  PREVIEW_DEVICES,
  copy,
  fill,
  isLocalDevUrl,
  projectSettingsOfOrDefault,
  type DevRun,
  type PreviewDevice,
  type ProjectId,
} from '@styx/core';
import { Button, Icon, Input } from '@styx/ui';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { onEvent } from '../../state/bridge';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import { useReadModel } from '../../state/read-model';
import { learnKey, learningSession, startLearnRun } from '../abilities/learn';
import { createLoginTerminal, disposeLoginTerminal } from '../modals/login-terminal';
import { attachTerminal, detachTerminal, type TerminalEntry } from '../terminal/terminal-registry';
import cm from '../modals/ConnectModal.module.css';
import s from './DesignPane.module.css';

export interface DesignPaneProps {
  projectId: ProjectId;
  /** The project's saved dev-server URL (`project.settings.devUrl`). */
  devUrl: string | null;
  /** False while the Code tab is showing: the native view detaches rather than hiding behind the editor. */
  active: boolean;
  /** The project's local run (`model.runs[projectId]`), main-owned; null when nothing was started or it was dismissed. */
  run: DevRun | null;
  /** The run command Styx has learned for this project (`project.settings.devCommand`); null until an agent taught it. */
  devCommand: string | null;
}

/** Why a finished run counts as failed, in the words the agent is asked to fix (`agentPrompt.fixRun`). */
export const runFailure = (run: DevRun): string | null => {
  if (run.phase !== 'exited') return null;
  if (run.exitCode !== null && run.exitCode !== 0)
    return fill(copy.workspace.run.failureExit, { code: String(run.exitCode) });
  return run.url === null ? copy.workspace.run.failureNoUrl : null;
};

/** The phase line in the output strip header: `Starting…` · `Running · http://localhost:5173` · `Exited · code 1`. */
export const runPhaseText = (run: DevRun): string => {
  switch (run.phase) {
    case 'starting':
      return copy.workspace.run.starting;
    case 'running':
      return run.url === null
        ? copy.workspace.run.runningNoUrl
        : fill(copy.workspace.run.running, { url: run.url });
    case 'exited':
      return fill(copy.workspace.run.exited, { code: String(run.exitCode ?? '') });
  }
};

/**
 * The design window: a live view of the running app, beside the code.
 *
 * The page itself is a native `WebContentsView` owned by main — it cannot be an iframe under the renderer's CSP.
 * This component is therefore chrome plus a measured hole: it reports the rectangle the view should occupy and
 * whether it should be on screen at all. It must report `visible: false` whenever an overlay is open, because a
 * native view paints above the DOM and would otherwise cover the palette, a modal, the grant sheet or a toast.
 *
 * "Run locally" (owner request) has its own row. It works the way asking an agent does (owner principle,
 * AI-native): the first click hands the job to the project's agent in chat, which works the command out, may ask a
 * question, and teaches Styx through `remember_command`; main then starts the dev server in a pty, the strip under
 * the row shows its output, and the first localhost URL it prints becomes the URL the window points at. Every later
 * click runs the remembered command directly; a failed run offers to send it back to the agent with what went wrong.
 */
export function DesignPane({ projectId, devUrl, active, run, devCommand }: DesignPaneProps) {
  const hole = useRef<HTMLDivElement>(null);
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const overlays = useUi((u) => u.overlays);
  const url = devUrl ?? '';
  // Re-seed the field when the saved URL changes (React's documented adjust-state-during-render pattern, rather
  // than an effect, which would cascade a second render every time the URL round-trips through main).
  const [seed, setSeed] = useState(url);
  const [draft, setDraft] = useState(url);
  if (seed !== url) {
    setSeed(url);
    setDraft(url);
  }
  // The run's URL fills an empty field straight away (main saves it as `devUrl` too, which re-seeds above).
  const runUrl = run?.url ?? null;
  const [filledFrom, setFilledFrom] = useState<string | null>(null);
  if (runUrl !== null && runUrl !== filledFrom) {
    setFilledFrom(runUrl);
    if (draft === '') setDraft(runUrl);
  }

  // --- run locally ---------------------------------------------------------
  const live = run !== null && run.phase !== 'exited';
  // The learned command is also the override: editable, saved on blur, run on Enter.
  const commandSeed = devCommand ?? '';
  const [cmdSeed, setCmdSeed] = useState(commandSeed);
  const [cmd, setCmd] = useState(commandSeed);
  if (cmdSeed !== commandSeed) {
    setCmdSeed(commandSeed);
    setCmd(commandSeed);
  }
  // Who works it out: the session doing so while it is alive, else the project's default agent.
  const runKey = learnKey.run(projectId);
  const learning = useUi((u) => u.learning);
  const setLearning = useUi((u) => u.setLearning);
  const learnerId = useModel((m) => learningSession(m, learning, runKey));
  const agentName = useModel((m) => {
    const learner = learnerId === null ? undefined : m.sessions.byId[learnerId];
    return copy.agentProducts[learner?.agent ?? projectSettingsOfOrDefault(m, projectId).defaultAgent];
  });
  // The agent taught Styx a (new) command: the row goes back to being a button.
  const taught = useRef(devCommand);
  useEffect(() => {
    if (taught.current === devCommand) return;
    taught.current = devCommand;
    if (learning[runKey] !== undefined) setLearning(runKey, null);
  }, [devCommand, learning, runKey, setLearning]);
  const startRun = () => {
    if (live) return;
    if (devCommand === null) {
      void startLearnRun(useReadModel.getState().model, projectId);
      return;
    }
    const next = cmd.trim();
    if (next === '') return;
    void command('run.start', { projectId, command: next });
  };
  const stopRun = () => void command('run.stop', { projectId });
  const dismissRun = () => void command('run.dismiss', { projectId });
  const failure = run === null ? null : runFailure(run);
  const askToFix = () => {
    if (run === null || failure === null) return;
    void startLearnRun(useReadModel.getState().model, projectId, { command: run.command, failure });
  };
  const saveCmd = () => {
    const next = cmd.trim();
    if (next === '' || next === devCommand) return;
    void command('project.settings.set', { projectId, patch: { devCommand: next } });
  };
  const onCmdKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      startRun();
    }
  };

  // The output strip: an xterm bound to the run's pty, kept for the run's lifetime and re-parented when the strip
  // is collapsed / expanded so scrollback survives the toggle. It is open while the server is coming up (the output
  // is the only feedback then), folds away the moment the app has a URL (the app is the feedback now, and the strip
  // would only take room from it: the design window is a native view, so nothing can float over it), and reopens
  // when the run fails. The toggle is the user's at any time in between.
  const [open, setOpen] = useState(run !== null && run.url === null && run.phase !== 'exited');
  const [seen, setSeen] = useState<{ runId: string | null; url: string | null; failed: boolean }>({
    runId: run?.runId ?? null,
    url: run?.url ?? null,
    failed: run !== null && runFailure(run) !== null,
  });
  {
    const runId = run?.runId ?? null;
    const url = run?.url ?? null;
    const failed = run !== null && runFailure(run) !== null;
    if (runId !== seen.runId || url !== seen.url || failed !== seen.failed) {
      setSeen({ runId, url, failed });
      if (runId !== seen.runId) setOpen(run !== null && url === null && run.phase !== 'exited');
      else if (url !== null && seen.url === null) setOpen(false);
      else if (failed && !seen.failed) setOpen(true);
    }
  }
  const host = useRef<HTMLDivElement>(null);
  const entry = useRef<TerminalEntry | null>(null);
  const terminalId = run?.terminalId ?? null;
  const screenReader = useModel((m) => m.settings.app.screenReader);
  useEffect(() => {
    if (terminalId === null) return;
    const t = createLoginTerminal(terminalId, { screenReader });
    entry.current = t;
    return () => {
      disposeLoginTerminal(t);
      entry.current = null;
    };
  }, [terminalId, screenReader]);
  useEffect(() => {
    const t = entry.current;
    const el = host.current;
    if (t === null || el === null || !open) return;
    attachTerminal(t, el);
    return () => detachTerminal(t);
  }, [terminalId, open]);

  // --- native view ---------------------------------------------------------
  // A native view sits above the DOM, so anything floating must take it off screen while it is open.
  const covered = overlays.length > 0;
  // A live run is the source of truth for where the app is; the saved URL is the fallback for "I run it myself".
  // Local servers only (a committed project file could otherwise point the window at a remote page).
  const previewUrl = live && run.url !== null ? run.url : isLocalDevUrl(url) ? url : '';
  const visible = active && !covered && previewUrl !== '';
  // Main probes a new URL until the server answers, then loads it; until then the hole says so.
  const [status, setStatus] = useState<{
    url: string;
    phase: 'waiting' | 'loaded' | 'failed';
    attempts: number;
  } | null>(null);
  useEffect(() => onEvent('preview.status', (s) => setStatus(s)), []);
  const pending = previewUrl !== '' && status !== null && status.phase !== 'loaded' ? status : null;

  const report = useCallback(() => {
    const el = hole.current;
    const box = el === null ? null : el.getBoundingClientRect();
    void command('preview.set', {
      projectId,
      visible: visible && box !== null,
      bounds: {
        x: Math.round(box?.left ?? 0),
        y: Math.round(box?.top ?? 0),
        width: Math.round(box?.width ?? 0),
        height: Math.round(box?.height ?? 0),
      },
      url: previewUrl,
      device,
    });
  }, [projectId, visible, previewUrl, device]);

  // Bounds change with the window, the chat pane's drag handle, the terminal's, the files pane and the output
  // strip — observe the hole itself rather than trying to enumerate every cause.
  useEffect(() => {
    report();
    const el = hole.current;
    if (el === null) return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    window.addEventListener('scroll', report, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, true);
    };
  }, [report]);

  // Leaving the pane (or the screen) must detach the view, not merely stop updating it.
  useEffect(
    () => () => {
      void command('preview.set', {
        projectId,
        visible: false,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        url: '',
        device: 'desktop',
      });
    },
    [projectId],
  );

  const [localOnly, setLocalOnly] = useState(false);
  const save = () => {
    const next = draft.trim();
    if (next !== '' && !isLocalDevUrl(next)) {
      setLocalOnly(true);
      return;
    }
    setLocalOnly(false);
    if (next === url) return;
    void command('project.settings.set', { projectId, patch: { devUrl: next === '' ? null : next } });
  };

  const onUrlKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  };

  return (
    <div className={s['pane']} data-design-pane="true">
      <div className={s['bar']}>
        <Input
          className={s['url'] ?? ''}
          mono
          value={draft}
          aria-label={copy.workspace.design.urlLabel}
          placeholder={copy.workspace.design.urlPlaceholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={save}
          onKeyDown={onUrlKeyDown}
        />
        <Button
          size="compact"
          variant="ghost"
          disabled={previewUrl === ''}
          onClick={() => void command('preview.reload', {})}
        >
          {copy.workspace.design.reload}
        </Button>
        <Button
          size="compact"
          variant="ghost"
          disabled={previewUrl === ''}
          onClick={() => void command('preview.openExternal', { url: previewUrl })}
        >
          {copy.workspace.design.openExternal}
        </Button>
      </div>
      {/* Run locally has its own row: the URL bar is full at the window minimum, and a run is a separate act. */}
      <div
        className={s['runRow']}
        data-run-row="true"
        data-learning={learnerId === null ? undefined : 'true'}
      >
        {live ? (
          <Button size="compact" variant="secondary" on onClick={stopRun} data-run-stop="true">
            {copy.workspace.run.stop}
          </Button>
        ) : learnerId !== null ? (
          <>
            <span className={s['phase']} data-phase="starting" role="status" data-run-learning="true">
              {fill(copy.workspace.run.learning, { agent: agentName })}
            </span>
            <button
              type="button"
              className={cm['link']}
              onClick={() => openTask(runKey)}
              data-run-open-chat="true"
            >
              {copy.workspace.run.openChat}
            </button>
          </>
        ) : (
          <Button
            size="compact"
            variant="secondary"
            disabled={devCommand !== null && cmd.trim() === ''}
            onClick={startRun}
            data-run-start="true"
          >
            {copy.workspace.run.run}
          </Button>
        )}
        {devCommand !== null || live ? (
          <Input
            className={s['cmd'] ?? ''}
            mono
            value={cmd}
            aria-label={copy.workspace.run.command}
            placeholder={copy.workspace.run.commandPlaceholder}
            spellCheck={false}
            autoComplete="off"
            disabled={live}
            onChange={(e) => setCmd(e.currentTarget.value)}
            onBlur={saveCmd}
            onKeyDown={onCmdKeyDown}
            data-run-command="true"
          />
        ) : learnerId === null ? (
          <span className={s['hint']} data-run-first-time="true">
            {fill(copy.workspace.run.firstTime, { agent: agentName })}
          </span>
        ) : null}
        <div className={s['devices']} role="group" aria-label={copy.workspace.design.devicesLabel}>
          {PREVIEW_DEVICES.map((d) => (
            <Button
              key={d}
              size="compact"
              variant="ghost"
              on={device === d}
              aria-pressed={device === d}
              onClick={() => setDevice(d)}
              data-preview-device={d}
            >
              {copy.workspace.design.devices[d]}
            </Button>
          ))}
        </div>
      </div>
      {run !== null && (
        <div className={s['strip']} data-run-strip="true" data-open={open ? 'true' : 'false'}>
          <div className={s['stripHead']}>
            <button
              type="button"
              className={s['toggle']}
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              data-run-toggle="true"
            >
              <Icon name="chevron" className={s['chevron']} />
              <span className="t-label">{copy.workspace.run.output}</span>
            </button>
            <span className={s['phase']} data-phase={run.phase} data-run-phase="true">
              {runPhaseText(run)}
            </span>
            {failure !== null && learnerId === null && (
              <button
                type="button"
                className={[cm['link'], s['dismiss']].join(' ')}
                onClick={askToFix}
                data-run-fix="true"
              >
                {fill(copy.workspace.run.askToFix, { agent: agentName })}
              </button>
            )}
            {run.phase === 'exited' && (
              <button
                type="button"
                className={[cm['link'], failure === null && learnerId === null ? s['dismiss'] : ''].join(' ')}
                onClick={dismissRun}
                data-run-dismiss="true"
              >
                {copy.workspace.run.dismiss}
              </button>
            )}
          </div>
          {open && <div ref={host} className={s['term']} data-run-terminal="true" />}
        </div>
      )}
      <div ref={hole} className={s['hole']} data-preview-hole="true">
        {previewUrl === '' && (
          <div className={s['empty']} data-preview-local-only={localOnly ? 'true' : undefined}>
            <span className="t-label">
              {localOnly ? copy.workspace.design.localOnly : copy.workspace.design.empty}
            </span>
            <span className={s['hint']}>{copy.workspace.design.hint}</span>
          </div>
        )}
        {pending !== null && (
          <div className={s['empty']} role="status" data-preview-status={pending.phase}>
            <span className="t-label">
              {fill(
                pending.phase === 'failed'
                  ? copy.workspace.design.unreachable
                  : copy.workspace.design.waiting,
                { url: pending.url },
              )}
            </span>
            {pending.phase === 'failed' ? (
              <Button size="compact" variant="secondary" onClick={() => void command('preview.reload', {})}>
                {copy.workspace.design.retry}
              </Button>
            ) : (
              <span className={s['hint']}>{copy.workspace.design.waitingHint}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
