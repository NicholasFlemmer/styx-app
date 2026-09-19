import {
  PREVIEW_VIEWPORTS,
  copy,
  fill,
  type DeviceInput,
  type DeviceSession,
  type ProjectId,
} from '@styx/core';

/**
 * The pure half of the mirrored device (owner request: the design tab as a simulator): the frame's fit, the
 * mapping from a pointer over the mirror element to device pixels, tap vs swipe, key names, and the batching of
 * typed characters. The pane and the mirror component only wire events to these.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A pointer sample in client pixels with its timestamp (ms). */
export interface PointerSample {
  x: number;
  y: number;
  t: number;
}

/** How often the pane tells main it is still looking at the device (keeps the screenshot poller alive). */
export const MIRROR_HEARTBEAT_MS = 30_000;
/** Movement beyond this (in on-screen pixels) turns a press into a swipe. */
export const SWIPE_THRESHOLD_PX = 8;
/** Typed characters are sent as one `text` event after this much idle. */
export const TEXT_IDLE_MS = 300;

/** The device's screen for the frame's aspect: what main measured, else the phone preset (iPhone 14 Pro). */
export const deviceScreen = (session: Pick<DeviceSession, 'screen'>): Size =>
  session.screen ?? PREVIEW_VIEWPORTS.phone;

/**
 * How far a frame of natural size `frame` must shrink to fit `stage` (the pane minus its margin). Never enlarges;
 * 1 while nothing has a size yet (first paint, jsdom), so the frame is never scaled to nothing.
 */
export const fitScale = (stage: Size, frame: Size): number => {
  if (stage.width <= 0 || stage.height <= 0 || frame.width <= 0 || frame.height <= 0) return 1;
  return Math.min(1, stage.width / frame.width, stage.height / frame.height);
};

const clamp = (v: number, max: number): number => Math.min(max, Math.max(0, Math.round(v)));

/**
 * A pointer position over the mirror element, in device screen pixels: scaled from the element's on-screen rect
 * (which is the frame's scaled rect), rounded, clamped to the screen.
 */
export const toScreenPoint = (
  rect: Rect,
  screen: Size,
  clientX: number,
  clientY: number,
): { x: number; y: number } => {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp(((clientX - rect.left) / rect.width) * screen.width, screen.width - 1),
    y: clamp(((clientY - rect.top) / rect.height) * screen.height, screen.height - 1),
  };
};

/** pointerdown → pointerup: a swipe (with its duration) when the pointer moved more than 8 px, else a tap where it went down. */
export const gestureInput = (
  down: PointerSample,
  up: PointerSample,
  rect: Rect,
  screen: Size,
): DeviceInput => {
  const from = toScreenPoint(rect, screen, down.x, down.y);
  if (Math.hypot(up.x - down.x, up.y - down.y) <= SWIPE_THRESHOLD_PX) return { kind: 'tap', ...from };
  const to = toScreenPoint(rect, screen, up.x, up.y);
  return {
    kind: 'swipe',
    x1: from.x,
    y1: from.y,
    x2: to.x,
    y2: to.y,
    durationMs: Math.min(5000, Math.max(1, Math.round(up.t - down.t))),
  };
};

/** The keys forwarded by name; anything else is either text (see `isPrintable`) or ignored. */
export const keyInput = (key: string): DeviceInput | null => {
  switch (key) {
    case 'Enter':
      return { kind: 'key', key: 'enter' };
    case 'Backspace':
      return { kind: 'key', key: 'backspace' };
    case 'Escape':
      return { kind: 'key', key: 'escape' };
    default:
      return null;
  }
};

/** A single character without a modifier: typed into the device rather than handled as a shortcut. */
export const isPrintable = (e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

export interface TextBatcher {
  push(ch: string): void;
  /** Sends what is buffered now (before a named key, on blur). */
  flush(): void;
  /** Drops the buffer and the timer (unmount). */
  dispose(): void;
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

const wallTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Batches typed characters into one `text` event after 300 ms of idle: one adb / idb call per burst, not per key. */
export const createTextBatcher = (
  send: (text: string) => void,
  timers: Timers = wallTimers,
  idleMs: number = TEXT_IDLE_MS,
): TextBatcher => {
  let buffer = '';
  let timer: unknown = null;
  const stop = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const flush = () => {
    stop();
    if (buffer === '') return;
    const text = buffer;
    buffer = '';
    send(text);
  };
  return {
    push(ch) {
      buffer += ch;
      stop();
      timer = timers.set(flush, idleMs);
    },
    flush,
    dispose() {
      stop();
      buffer = '';
    },
  };
};

/** Where a screenshots-mode frame is read from (`Cache-Control: no-store` in main; `seq` defeats the image cache). */
export const frameUrl = (projectId: ProjectId, seq: number): string =>
  `styx-device://frame/${projectId}?seq=${seq}`;

export const mirrorModeLabel = (mode: DeviceSession['mirror']): string => {
  switch (mode) {
    case 'window':
      return copy.workspace.device.mirrorWindow;
    case 'screenshots':
      return copy.workspace.device.mirrorScreenshots;
    case 'none':
      return copy.workspace.device.mirrorNone;
  }
};

/**
 * The device row's text: `Booting iPhone 17 Pro…` · `Mirroring · iPhone 17 Pro · live` · `Simulator failed: …`.
 * `mode` is what the pane is actually showing when it knows (the `device.mirror` answer), else main's word.
 */
export const deviceRowText = (
  session: DeviceSession,
  mode: DeviceSession['mirror'] = session.mirror,
): string => {
  switch (session.phase) {
    case 'booting':
      return fill(copy.workspace.device.booting, { device: session.deviceName });
    case 'ready':
      return `${fill(copy.workspace.device.ready, { device: session.deviceName })} · ${mirrorModeLabel(mode)}`;
    case 'failed':
      return fill(copy.workspace.device.failed, { error: session.error ?? '' });
    case 'stopped':
      return copy.workspace.device.stopped;
  }
};
