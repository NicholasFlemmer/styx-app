import { copy, fill, type DeviceInput, type DeviceSession, type ProjectId } from '@styx/core';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { command } from '../../state/commands';
import {
  createTextBatcher,
  deviceScreen,
  frameUrl,
  gestureInput,
  isPrintable,
  keyInput,
  toScreenPoint,
  type PointerSample,
} from './device-mirror';
import type { MirrorState } from './use-device-mirror';
import s from './DesignPane.module.css';

export interface DeviceMirrorProps {
  projectId: ProjectId;
  /** A `ready` session. */
  session: DeviceSession;
  mirror: MirrorState;
}

/**
 * The device's screen inside the frame: the live window capture (`<video>`) or the latest screenshot (`<img>`).
 * With an input bridge (adb; idb on iOS) the picture is an `application` region — the role that puts assistive
 * tech into pass-through mode, since every key typed here goes to the device — and forwards taps, swipes, keys
 * and typed text mapped to the device's own pixels. Without a bridge it is a plain picture; the pane's device
 * row says why and offers the simulator's window. What the pane shows *around* the picture (no picture, booting)
 * is rendered by the pane in an unscaled layer, because this element is inside the scaled frame.
 */
export function DeviceMirror({ projectId, session, mirror }: DeviceMirrorProps) {
  const screen = deviceScreen(session);
  const label = fill(copy.workspace.device.mirrorLabel, { device: session.deviceName });
  const hintId = useId();
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = video.current;
    if (v === null) return;
    v.srcObject = mirror.stream;
  }, [mirror.stream, mirror.mode]);

  // --- input ---------------------------------------------------------------
  const surface = useRef<HTMLDivElement>(null);
  const send = (event: DeviceInput) => void command('device.input', { projectId, event });
  const batcher = useMemo(
    () =>
      createTextBatcher((text) => void command('device.input', { projectId, event: { kind: 'text', text } })),
    [projectId],
  );
  useEffect(() => () => batcher.dispose(), [batcher]);
  const gesture = useRef<PointerSample | null>(null);
  // A pointer gesture already answered the press: the click that follows it must not tap twice.
  const consumed = useRef(false);
  const rect = () => surface.current?.getBoundingClientRect() ?? null;
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!session.input || e.button !== 0) return;
    gesture.current = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    consumed.current = false;
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const down = gesture.current;
    if (down === null) return;
    gesture.current = null;
    consumed.current = true;
    const r = rect();
    if (r === null) return;
    send(gestureInput(down, { x: e.clientX, y: e.clientY, t: e.timeStamp }, r, screen));
  };
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!session.input) return;
    if (consumed.current) {
      consumed.current = false;
      return;
    }
    const r = rect();
    if (r === null) return;
    send({ kind: 'tap', ...toScreenPoint(r, screen, e.clientX, e.clientY) });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!session.input) return;
    const named = keyInput(e.key);
    if (named !== null) {
      e.preventDefault();
      batcher.flush();
      send(named);
      return;
    }
    if (isPrintable(e)) {
      e.preventDefault();
      batcher.push(e.key);
    }
  };

  const mode = mirror.mode ?? 'none';
  const picture = mode === 'window' || mode === 'screenshots';
  return (
    <div className={s['mirror']} data-device-frame="true" data-mirror={mode}>
      {picture && (
        <div
          ref={surface}
          className={s['surface']}
          role={session.input ? 'application' : 'img'}
          aria-roledescription={session.input ? copy.workspace.device.surfaceRole : undefined}
          aria-label={label}
          aria-describedby={session.input ? hintId : undefined}
          tabIndex={session.input ? 0 : undefined}
          data-device-surface="true"
          data-device-input={session.input ? 'true' : 'false'}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onClick={onClick}
          onKeyDown={onKeyDown}
          onBlur={() => batcher.flush()}
        >
          {mode === 'window' ? (
            <video
              ref={video}
              className={s['picture']}
              autoPlay
              muted
              playsInline
              aria-hidden="true"
              data-device-video="true"
            />
          ) : mirror.seq > 0 ? (
            <img
              className={s['picture']}
              src={frameUrl(projectId, mirror.seq)}
              alt=""
              aria-hidden="true"
              draggable={false}
              data-device-image="true"
            />
          ) : null}
          {session.input && (
            <span id={hintId} className="visually-hidden">
              {copy.workspace.device.surfaceHint}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
