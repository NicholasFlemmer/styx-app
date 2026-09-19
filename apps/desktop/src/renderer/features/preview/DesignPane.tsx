import { openTask } from '../tasks/task-launch';
import {
  PREVIEW_DEVICES,
  PREVIEW_VIEWPORTS,
  copy,
  fill,
  isLocalDevUrl,
  projectSettingsOfOrDefault,
  type CommandOutput,
  type DevPlatform,
  type DevRun,
  type DeviceSession,
  type DeviceSummary,
  type DevicePlatform,
  type PreviewDevice,
  type ProjectId,
  type WorktreeId,
} from '@styx/core';
import { Button, ChipGroup, DeviceFrame, Icon, Input, Select, StatusDot } from '@styx/ui';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { onEvent } from '../../state/bridge';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import { useReadModel } from '../../state/read-model';
import { learnKey, learningSession, startLearnRun } from '../abilities/learn';
import { createLoginTerminal, disposeLoginTerminal } from '../modals/login-terminal';
import { attachTerminal, detachTerminal, type TerminalEntry } from '../terminal/terminal-registry';
import cm from '../modals/ConnectModal.module.css';
import { deviceRowText, deviceScreen, fitScale } from './device-mirror';
import { DeviceMirror } from './DeviceMirror';
import { useDeviceMirror } from './use-device-mirror';
import s from './DesignPane.module.css';

export interface DesignPaneProps {
  projectId: ProjectId;
  /** The lane the workspace is showing (the active session's worktree): Run locally looks and runs there; null = main. */
  worktreeId: WorktreeId | null;
  /** The project's saved dev-server URL (`project.settings.devUrl`). */
  devUrl: string | null;
  /** False while the Code tab is showing: the native view detaches rather than hiding behind the editor. */
  active: boolean;
  /** The project's local run (`model.runs[projectId]`), main-owned; null when nothing was started or it was dismissed. */
  run: DevRun | null;
  /** The run command Styx has learned for this project (`project.settings.devCommand`); null until an agent taught it. */
  devCommand: string | null;
  /** The simulator / emulator mirrored for this project (`model.devices[projectId]`), main-owned; null when none. */
  device: DeviceSession | null;
  /** What "Run locally" targets (`project.settings.devPlatform`); null = whatever detection puts first. */
  devPlatform: DevPlatform | null;
  /** The remembered simulator by name (`project.settings.devDevice`); null = Styx picks one. */
  devDevice: string | null;
}

type Tooling = CommandOutput<'device.tooling'>;

/** Why a finished run counts as failed, in the words the agent is asked to fix (`agentPrompt.fixRun`). */
export const runFailure = (run: DevRun): string | null => {
  if (run.phase !== 'exited') return null;
  if (run.exitCode !== null && run.exitCode !== 0)
    return fill(copy.workspace.run.failureExit, { code: String(run.exitCode) });
  // A device run shows the app on the simulator, never on a URL.
  if (run.platform !== 'web') return null;
  return run.url === null ? copy.workspace.run.failureNoUrl : null;
};

/** The phase line in the output strip header: `Starting…` · `Running · http://localhost:5173` · `Exited · code 1`. */
export const runPhaseText = (run: DevRun): string => {
  switch (run.phase) {
    case 'starting':
      return copy.workspace.run.starting;
    case 'running':
      if (run.platform !== 'web')
        return fill(copy.workspace.run.runningDevice, {
          platform: copy.workspace.device.platforms[run.platform],
        });
      return run.url === null
        ? copy.workspace.run.runningNoUrl
        : fill(copy.workspace.run.running, { url: run.url });
    case 'exited':
      return fill(copy.workspace.run.exited, { code: String(run.exitCode ?? '') });
  }
};

/** The chips show only when the repo can run on more than the web. */
const isMobile = (platforms: readonly DevPlatform[]): boolean => platforms.some((p) => p !== 'web');

/** Device-picker options: `Any device`, then each simulator once by name (booted first, as main lists them). */
const deviceOptions = (devices: readonly DeviceSummary[], chosen: string | null) => {
  const seen = new Set<string>();
  const out: { value: string; label: string }[] = [{ value: '', label: copy.workspace.device.pickAny }];
  for (const d of devices) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    out.push({ value: d.name, label: d.runtime === null ? d.name : `${d.name} · ${d.runtime}` });
  }
  // The remembered device is not on this machine: still show it, so the setting is visible and can be changed.
  if (chosen !== null && !seen.has(chosen)) out.push({ value: chosen, label: chosen });
  return out;
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
 *
 * A mobile app (owner request: the design tab as a simulator, like Xcode's beside the editor) runs on the iOS
 * Simulator / Android Emulator instead: the Run row gains the platform and a device picker, main boots the device
 * and the hole shows it inside a phone frame — the simulator's window captured live, or its screenshots — with
 * taps and typing forwarded when the platform has an input bridge.
 */
export function DesignPane({
  projectId,
  worktreeId,
  devUrl,
  active,
  run,
  devCommand,
  device,
  devPlatform,
  devDevice,
}: DesignPaneProps) {
  const hole = useRef<HTMLDivElement>(null);
  const [preset, setPreset] = useState<PreviewDevice>('desktop');
  const [landscape, setLandscape] = useState(false);
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

  // --- platform & device ---------------------------------------------------
  // What the repo can run on, most likely first; the chips appear only for a mobile app.
  const [platforms, setPlatforms] = useState<DevPlatform[]>([]);
  useEffect(() => {
    let cancelled = false;
    void command('run.detect', { projectId, ...(worktreeId === null ? {} : { worktreeId }) }).then((r) => {
      if (!cancelled && r.ok) setPlatforms(r.value.platforms);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, worktreeId]);
  const mobile = isMobile(platforms);
  const platform: DevPlatform = devPlatform ?? platforms[0] ?? 'web';
  const devicePlatform: DevicePlatform | null = platform === 'web' ? null : platform;
  const [tooling, setTooling] = useState<Tooling | null>(null);
  useEffect(() => {
    if (!mobile) return;
    let cancelled = false;
    void command('device.tooling', {}).then((r) => {
      if (!cancelled && r.ok) setTooling(r.value);
    });
    return () => {
      cancelled = true;
    };
  }, [mobile]);
  // Unknown counts as present: the picker shows until main says the tooling is missing.
  const toolingMissing = devicePlatform !== null && tooling !== null && !tooling[devicePlatform];
  // The simulators are listed once the tooling is known to be there (listing runs the platform's own tools).
  const toolingPresent = devicePlatform !== null && tooling !== null && tooling[devicePlatform];
  // The list is remembered with the platform it was fetched for, so switching platforms never shows stale names.
  const [listed, setListed] = useState<{ platform: DevicePlatform; devices: DeviceSummary[] } | null>(null);
  useEffect(() => {
    if (devicePlatform === null || !toolingPresent) return;
    let cancelled = false;
    void command('device.list', { platform: devicePlatform }).then((r) => {
      if (!cancelled && r.ok) setListed({ platform: devicePlatform, devices: r.value.devices });
    });
    return () => {
      cancelled = true;
    };
  }, [devicePlatform, toolingPresent]);
  const devices = listed !== null && listed.platform === devicePlatform ? listed.devices : [];
  const choosePlatform = (p: DevPlatform) => {
    if (p === platform) return;
    void command('project.settings.set', { projectId, patch: { devPlatform: p === 'web' ? null : p } });
  };
  const chooseDevice = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = e.currentTarget.value;
    void command('project.settings.set', { projectId, patch: { devDevice: next === '' ? null : next } });
  };

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
      void startLearnRun(useReadModel.getState().model, projectId, undefined, worktreeId);
      return;
    }
    const next = cmd.trim();
    if (next === '') return;
    void command('run.start', {
      projectId,
      command: next,
      platform,
      ...(worktreeId === null ? {} : { worktreeId }),
    });
  };
  const stopRun = () => void command('run.stop', { projectId });
  const dismissRun = () => void command('run.dismiss', { projectId });
  const failure = run === null ? null : runFailure(run);
  const askToFix = () => {
    if (run === null || failure === null) return;
    void startLearnRun(
      useReadModel.getState().model,
      projectId,
      { command: run.command, failure },
      worktreeId,
    );
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
  const commandPlaceholder =
    devicePlatform === 'ios'
      ? copy.workspace.run.commandPlaceholderIos
      : devicePlatform === 'android'
        ? copy.workspace.run.commandPlaceholderAndroid
        : copy.workspace.run.commandPlaceholder;

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

  // --- the device session --------------------------------------------------
  // The simulator takes the hole while it boots and while it is mirrored; a failed or stopped one only keeps its row.
  const mirroring = device !== null && (device.phase === 'booting' || device.phase === 'ready');
  const ready = device !== null && device.phase === 'ready';
  const mirror = useDeviceMirror(projectId, ready, active);
  const stopDevice = (shutdown: boolean) => void command('device.stop', { projectId, shutdown });
  const focusDevice = () => void command('device.focus', { projectId });
  // Not live because the OS will not let Styx capture the window: say so, and open the pane where that changes.
  const screenAccess = ready && mirror.mode !== null && mirror.mode !== 'window' && mirror.reason !== null;
  // Taps and typing cannot reach the device (no adb / idb): the row explains, and names the way to interact.
  const noInput = ready && !device.input;
  const noInputId = useId();
  const screenAccessId = useId();

  // --- native view ---------------------------------------------------------
  // A native view sits above the DOM, so anything floating must take it off screen while it is open.
  const covered = overlays.length > 0;
  // A live run is the source of truth for where the app is; the saved URL is the fallback for "I run it myself".
  // Local servers only (a committed project file could otherwise point the window at a remote page). A device
  // platform has no page: the simulator is the app.
  const previewUrl =
    devicePlatform !== null ? '' : live && run.url !== null ? run.url : isLocalDevUrl(url) ? url : '';
  const visible = active && !covered && previewUrl !== '' && !mirroring;
  // Main probes a new URL until the server answers, then loads it; until then the hole says so.
  const [status, setStatus] = useState<{
    url: string;
    phase: 'waiting' | 'loaded' | 'failed';
    attempts: number;
  } | null>(null);
  useEffect(() => onEvent('preview.status', (s) => setStatus(s)), []);
  const pending = previewUrl !== '' && status !== null && status.phase !== 'loaded' ? status : null;

  // --- the frame -----------------------------------------------------------
  // A phone around the mirrored device (its own screen size); a phone / tablet around the web presets. The frame
  // is laid out here, at the device's real size, and shrunk with a transform when the pane is smaller; main is
  // told the screen slot's on-screen (scaled) rectangle and trusts it.
  const frameKind: 'phone' | 'tablet' | null = mirroring
    ? 'phone'
    : devicePlatform !== null || preset === 'desktop'
      ? null
      : preset;
  const natural = mirroring
    ? deviceScreen(device)
    : PREVIEW_VIEWPORTS[preset === 'desktop' ? 'phone' : preset];
  const sideways = mirroring ? natural.width > natural.height : landscape;
  const screen = sideways && !mirroring ? { width: natural.height, height: natural.width } : natural;
  const frameLabel = fill(copy.workspace.design.frameLabel, {
    device: mirroring ? device.deviceName : copy.workspace.design.devices[preset],
  });
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const measure = useCallback(() => {
    const st = stage.current;
    const fr = frame.current;
    setScale(
      st === null || fr === null
        ? 1
        : fitScale(
            { width: st.clientWidth, height: st.clientHeight },
            { width: fr.offsetWidth, height: fr.offsetHeight },
          ),
    );
  }, []);
  useLayoutEffect(measure, [measure, frameKind, screen.width, screen.height]);

  const report = useCallback(() => {
    const el = slot.current ?? hole.current;
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
      device: preset,
    });
  }, [projectId, visible, previewUrl, preset]);

  // Bounds change with the window, the chat pane's drag handle, the terminal's, the files pane and the output
  // strip — observe the hole itself rather than trying to enumerate every cause. The slot is inside the frame,
  // so its rectangle also follows the frame's kind, scale and orientation: re-report on those too.
  useEffect(() => {
    report();
    const el = hole.current;
    if (el === null) return;
    const onResize = () => {
      measure();
      report();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', report, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', report, true);
    };
  }, [report, measure, frameKind, scale, screen.width, screen.height]);

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

  // What the hole (or the screen slot, when a frame is up) says while there is nothing to show.
  const notice = mirroring ? null : devicePlatform !== null ? (
    <div className={s['empty']} data-device-empty={devicePlatform}>
      <span className="t-label">
        {toolingMissing
          ? devicePlatform === 'ios'
            ? copy.workspace.device.noToolingIos
            : copy.workspace.device.noToolingAndroid
          : copy.workspace.device.empty}
      </span>
      {toolingMissing && (
        <span className={s['hint']}>
          {devicePlatform === 'ios'
            ? copy.workspace.device.noToolingIosHint
            : copy.workspace.device.noToolingAndroidHint}
        </span>
      )}
    </div>
  ) : previewUrl === '' ? (
    <div className={s['empty']} data-preview-local-only={localOnly ? 'true' : undefined}>
      <span className="t-label">
        {localOnly ? copy.workspace.design.localOnly : copy.workspace.design.empty}
      </span>
      <span className={s['hint']}>{copy.workspace.design.hint}</span>
    </div>
  ) : pending !== null ? (
    <div className={s['empty']} role="status" data-preview-status={pending.phase}>
      <span className="t-label">
        {fill(
          pending.phase === 'failed' ? copy.workspace.design.unreachable : copy.workspace.design.waiting,
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
  ) : null;

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
        data-run-platform-selected={platform}
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
        {mobile && (
          <ChipGroup
            layout="inline"
            size="env"
            aria-label={copy.workspace.device.platformLabel}
            options={platforms.map((p) => ({
              value: p,
              label: copy.workspace.device.platforms[p],
              disabled: live,
            }))}
            value={platform}
            onChange={(v) => choosePlatform(v as DevPlatform)}
            data-run-platforms="true"
          />
        )}
        {devicePlatform !== null &&
          (toolingMissing ? (
            <span className={s['hint']} data-device-no-tooling={devicePlatform}>
              {devicePlatform === 'ios'
                ? copy.workspace.device.noToolingIos
                : copy.workspace.device.noToolingAndroid}
            </span>
          ) : (
            <Select
              width={150}
              aria-label={copy.workspace.device.pick}
              value={devDevice ?? ''}
              disabled={live}
              options={deviceOptions(devices, devDevice)}
              onChange={chooseDevice}
              data-device-pick="true"
            />
          ))}
        {devCommand !== null || live ? (
          <Input
            className={s['cmd'] ?? ''}
            mono
            value={cmd}
            aria-label={copy.workspace.run.command}
            placeholder={commandPlaceholder}
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
            {devicePlatform !== null
              ? copy.workspace.run.firstTimeDevice
              : fill(copy.workspace.run.firstTime, { agent: agentName })}
          </span>
        ) : null}
        {/* The presets frame the web page; a simulator is its own device. */}
        {devicePlatform === null && (
          <div className={s['devices']} role="group" aria-label={copy.workspace.design.devicesLabel}>
            {PREVIEW_DEVICES.map((d) => (
              <Button
                key={d}
                size="compact"
                variant="ghost"
                on={preset === d}
                aria-pressed={preset === d}
                onClick={() => setPreset(d)}
                data-preview-device={d}
              >
                {copy.workspace.design.devices[d]}
              </Button>
            ))}
            {preset !== 'desktop' && (
              <Button
                size="compact"
                variant="ghost"
                aria-pressed={landscape}
                onClick={() => setLandscape((l) => !l)}
                data-preview-rotate="true"
              >
                {copy.workspace.design.rotate}
              </Button>
            )}
          </div>
        )}
      </div>
      {device !== null && (
        <div className={s['deviceRow']} data-device-row="true" data-device-phase={device.phase}>
          {device.phase === 'booting' && <StatusDot tone="accent" className={s['blink']} />}
          <span
            className={s['deviceText']}
            role={device.phase === 'failed' ? 'alert' : 'status'}
            data-device-text="true"
          >
            {deviceRowText(device, mirror.mode ?? device.mirror)}
          </span>
          {device.phase === 'ready' && (
            <button
              type="button"
              className={cm['link']}
              onClick={focusDevice}
              aria-describedby={noInput ? noInputId : undefined}
              data-device-focus="true"
            >
              {copy.workspace.device.focus}
            </button>
          )}
          {device.phase === 'ready' && (
            <button
              type="button"
              className={cm['link']}
              onClick={() => stopDevice(true)}
              data-device-shutdown="true"
            >
              {copy.workspace.device.shutdown}
            </button>
          )}
          <button
            type="button"
            className={[cm['link'], s['dismiss']].join(' ')}
            onClick={() => stopDevice(false)}
            data-device-stop="true"
          >
            {device.phase === 'stopped' || device.phase === 'failed'
              ? copy.workspace.run.dismiss
              : copy.workspace.device.stop}
          </button>
        </div>
      )}
      {/* No input bridge: said once, in a row that stays, rather than on a click nobody without a mouse can make. */}
      {noInput && (
        <div className={s['noticeRow']} data-device-no-input="true">
          <span id={noInputId} className={s['hint']}>
            {device?.platform === 'ios' ? copy.workspace.device.noInputIos : copy.workspace.device.noInput}
          </span>
        </div>
      )}
      {screenAccess && (
        <div className={s['noticeRow']} data-device-screen-access-row="true">
          <span id={screenAccessId} className={s['hint']}>
            {copy.workspace.device.screenAccess}
          </span>
          <button
            type="button"
            className={cm['link']}
            onClick={() => void command('device.openScreenAccess', {})}
            aria-describedby={screenAccessId}
            data-device-screen-access="true"
          >
            {copy.workspace.device.screenAccessOpen}
          </button>
        </div>
      )}
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
      <div
        ref={hole}
        className={s['hole']}
        data-preview-hole="true"
        data-preview-frame={frameKind ?? undefined}
      >
        {frameKind !== null ? (
          <div ref={stage} className={s['stage']}>
            <DeviceFrame
              ref={frame}
              kind={frameKind}
              landscape={sideways}
              width={screen.width}
              height={screen.height}
              label={frameLabel}
              className={s['frame'] ?? ''}
              style={{ transform: `scale(${scale})` }}
              data-preview-frame-kind={frameKind}
              data-preview-landscape={sideways ? 'true' : 'false'}
            >
              {ready ? (
                <DeviceMirror projectId={projectId} session={device} mirror={mirror} />
              ) : mirroring ? null : (
                <div ref={slot} className={s['slot']} data-preview-slot="true" />
              )}
            </DeviceFrame>
            {/* Words and buttons never go inside the frame: it is scaled, and 10px type at a third scale is not
                readable nor a 28px target tappable. They sit in their own layer over the stage, at full size. */}
            {mirroring && !ready ? (
              <div
                className={[s['empty'], s['over']].join(' ')}
                aria-hidden="true"
                data-device-booting="true"
              >
                <span className="t-label">{deviceRowText(device)}</span>
              </div>
            ) : ready && mirror.mode !== null && mirror.mode === 'none' ? (
              <div className={[s['empty'], s['over']].join(' ')} role="status" data-device-no-picture="true">
                <span className="t-label">{copy.workspace.device.mirrorNone}</span>
                {mirror.reason !== null && <span className={s['hint']}>{mirror.reason}</span>}
              </div>
            ) : notice !== null && !mirroring ? (
              <div className={s['over']}>{notice}</div>
            ) : null}
          </div>
        ) : (
          notice
        )}
      </div>
    </div>
  );
}
