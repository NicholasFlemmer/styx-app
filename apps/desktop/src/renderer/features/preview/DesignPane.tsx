import { PREVIEW_DEVICES, copy, fill, type DevRun, type PreviewDevice, type ProjectId } from '@styx/core';
import { Button, Icon, Input } from '@styx/ui';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { command } from '../../state/commands';
import { useUi } from '../../state/hooks';
import { createLoginTerminal, disposeLoginTerminal } from '../modals/login-terminal';
import { attachTerminal, detachTerminal, type TerminalEntry } from '../terminal/terminal-registry';
import s from './DesignPane.module.css';

export interface DesignPaneProps {
  projectId: ProjectId;
  /** The project's saved dev-server URL (`project.settings.devUrl`). */
  devUrl: string | null;
  /** False while the Code tab is showing: the native view detaches rather than hiding behind the editor. */
  active: boolean;
  /** The project's local run (`model.runs[projectId]`), main-owned; null when nothing was started or it was dismissed. */
  run: DevRun | null;
  /** The saved run command (`project.settings.devCommand`); null falls back to what `run.detect` suggests. */
  devCommand: string | null;
}

type Suggestion = { command: string; source: string };

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
 * "Run locally" (owner request) lives in the same bar: main starts the project's dev server in a pty, the strip
 * under the bar shows its output, and the first localhost URL it prints becomes the URL the window points at.
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
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  useEffect(() => {
    let cancelled = false;
    void command('run.detect', { projectId }).then((r) => {
      if (cancelled || !r.ok) return;
      setSuggestion(r.value.suggestions[0] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  const commandSeed = devCommand ?? suggestion?.command ?? '';
  const [cmdSeed, setCmdSeed] = useState(commandSeed);
  const [cmd, setCmd] = useState(commandSeed);
  if (cmdSeed !== commandSeed) {
    setCmdSeed(commandSeed);
    setCmd(commandSeed);
  }
  const detectedTitle =
    devCommand === null && suggestion !== null && cmd === suggestion.command
      ? fill(copy.workspace.run.detected, { source: suggestion.source })
      : undefined;
  const startRun = () => {
    const next = cmd.trim();
    if (next === '' || live) return;
    void command('run.start', { projectId, command: next });
  };
  const stopRun = () => void command('run.stop', { projectId });
  const dismissRun = () => void command('run.dismiss', { projectId });
  const onCmdKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      startRun();
    }
  };

  // The output strip: an xterm bound to the run's pty, kept for the run's lifetime and re-parented when the strip
  // is collapsed / expanded so scrollback survives the toggle.
  const [open, setOpen] = useState(true);
  const host = useRef<HTMLDivElement>(null);
  const entry = useRef<TerminalEntry | null>(null);
  const terminalId = run?.terminalId ?? null;
  useEffect(() => {
    if (terminalId === null) return;
    const t = createLoginTerminal(terminalId);
    entry.current = t;
    return () => {
      disposeLoginTerminal(t);
      entry.current = null;
    };
  }, [terminalId]);
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
  const visible = active && !covered && url !== '';

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
      url,
      device,
    });
  }, [projectId, visible, url, device]);

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

  const save = () => {
    const next = draft.trim();
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
        {live ? (
          <Button size="compact" variant="secondary" on onClick={stopRun} data-run-stop="true">
            <span className={s['glyph']} aria-hidden="true">
              ■
            </span>
            {copy.workspace.run.stop}
          </Button>
        ) : (
          <Button
            size="compact"
            variant="secondary"
            disabled={cmd.trim() === ''}
            onClick={startRun}
            data-run-start="true"
          >
            <span className={s['glyph']} aria-hidden="true">
              ▶
            </span>
            {copy.workspace.run.run}
          </Button>
        )}
        <Input
          className={s['cmd'] ?? ''}
          mono
          value={cmd}
          aria-label={copy.workspace.run.command}
          placeholder={copy.workspace.run.commandPlaceholder}
          title={detectedTitle}
          spellCheck={false}
          autoComplete="off"
          disabled={live}
          onChange={(e) => setCmd(e.currentTarget.value)}
          onKeyDown={onCmdKeyDown}
          data-run-command="true"
        />
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
        <div className={s['devices']} role="group" aria-label={copy.workspace.design.devices.desktop}>
          {PREVIEW_DEVICES.map((d) => (
            <Button
              key={d}
              size="compact"
              variant="ghost"
              on={device === d}
              onClick={() => setDevice(d)}
              data-preview-device={d}
            >
              {copy.workspace.design.devices[d]}
            </Button>
          ))}
        </div>
        <Button
          size="compact"
          variant="ghost"
          disabled={url === ''}
          onClick={() => void command('preview.reload', {})}
        >
          {copy.workspace.design.reload}
        </Button>
        <Button
          size="compact"
          variant="ghost"
          disabled={url === ''}
          onClick={() => void command('preview.openExternal', { url })}
        >
          {copy.workspace.design.openExternal}
        </Button>
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
            {run.phase === 'exited' && (
              <button type="button" className={s['link']} onClick={dismissRun} data-run-dismiss="true">
                {copy.workspace.run.dismiss}
              </button>
            )}
          </div>
          {open && <div ref={host} className={s['term']} data-run-terminal="true" />}
        </div>
      )}
      <div ref={hole} className={s['hole']} data-preview-hole="true">
        {url === '' && (
          <div className={s['empty']}>
            <span className="t-label">{copy.workspace.design.empty}</span>
            <span className={s['hint']}>{copy.workspace.design.hint}</span>
          </div>
        )}
      </div>
    </div>
  );
}
