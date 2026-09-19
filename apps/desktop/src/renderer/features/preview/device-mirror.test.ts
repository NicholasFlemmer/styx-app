import { copy, fixtures, type DeviceSession } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createTextBatcher,
  deviceRowText,
  deviceScreen,
  fitScale,
  frameUrl,
  gestureInput,
  isPrintable,
  keyInput,
  mirrorModeLabel,
  toScreenPoint,
  type Timers,
} from './device-mirror';

const acme = fixtures.ids.project.acmeShop;

const session = (over: Partial<DeviceSession> = {}): DeviceSession => ({
  projectId: acme,
  platform: 'ios',
  deviceId: 'UDID-1',
  deviceName: 'iPhone 17 Pro',
  phase: 'ready',
  mirror: 'screenshots',
  input: true,
  error: null,
  screen: { width: 1179, height: 2556 },
  startedAt: fixtures.DEMO_NOW,
  ...over,
});

describe('fitScale', () => {
  it.each([
    ['fits already', { width: 900, height: 900 }, { width: 420, height: 920 }, 900 / 920],
    ['never enlarges', { width: 2000, height: 2000 }, { width: 420, height: 920 }, 1],
    ['the narrow side wins', { width: 300, height: 2000 }, { width: 420, height: 920 }, 300 / 420],
    ['nothing measured yet (jsdom, first paint)', { width: 0, height: 0 }, { width: 420, height: 920 }, 1],
    ['frame not laid out yet', { width: 900, height: 900 }, { width: 0, height: 0 }, 1],
  ])('%s', (_name, stage, frame, expected) => {
    expect(fitScale(stage, frame)).toBeCloseTo(expected, 6);
  });
});

describe('toScreenPoint', () => {
  // The frame is scaled to half: a 393×852 screen shown at 196.5×426 at (100, 50).
  const rect = { left: 100, top: 50, width: 196.5, height: 426 };
  const screen = { width: 393, height: 852 };
  it('scales from the element rect to device pixels and rounds', () => {
    expect(toScreenPoint(rect, screen, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(toScreenPoint(rect, screen, 100 + 98.25, 50 + 213)).toEqual({ x: 197, y: 426 });
  });
  it('clamps to the screen', () => {
    expect(toScreenPoint(rect, screen, 90, 40)).toEqual({ x: 0, y: 0 });
    expect(toScreenPoint(rect, screen, 400, 600)).toEqual({ x: 392, y: 851 });
  });
  it('a rect with no size maps to the origin rather than NaN', () => {
    expect(toScreenPoint({ left: 0, top: 0, width: 0, height: 0 }, screen, 10, 10)).toEqual({ x: 0, y: 0 });
  });
});

describe('gestureInput', () => {
  const rect = { left: 0, top: 0, width: 393, height: 852 };
  const screen = { width: 393, height: 852 };
  it('a press that barely moves is a tap where it went down', () => {
    expect(gestureInput({ x: 10, y: 20, t: 1000 }, { x: 15, y: 24, t: 1100 }, rect, screen)).toEqual({
      kind: 'tap',
      x: 10,
      y: 20,
    });
  });
  it('more than 8 px of movement is a swipe with its duration', () => {
    expect(gestureInput({ x: 10, y: 400, t: 1000 }, { x: 300, y: 402, t: 1250.4 }, rect, screen)).toEqual({
      kind: 'swipe',
      x1: 10,
      y1: 400,
      x2: 300,
      y2: 402,
      durationMs: 250,
    });
  });
  it('the duration is clamped to what the device accepts (1 … 5000 ms)', () => {
    const fast = gestureInput({ x: 0, y: 0, t: 0 }, { x: 100, y: 0, t: 0 }, rect, screen);
    const slow = gestureInput({ x: 0, y: 0, t: 0 }, { x: 100, y: 0, t: 99_999 }, rect, screen);
    expect(fast).toMatchObject({ kind: 'swipe', durationMs: 1 });
    expect(slow).toMatchObject({ kind: 'swipe', durationMs: 5000 });
  });
});

describe('keys and text', () => {
  it('names the keys the device understands and ignores the rest', () => {
    expect(keyInput('Enter')).toEqual({ kind: 'key', key: 'enter' });
    expect(keyInput('Backspace')).toEqual({ kind: 'key', key: 'backspace' });
    expect(keyInput('Escape')).toEqual({ kind: 'key', key: 'escape' });
    expect(keyInput('Tab')).toBeNull();
    expect(keyInput('a')).toBeNull();
  });
  it('a printable character is a single key without a modifier', () => {
    const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
      key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...mods,
    });
    expect(isPrintable(k('a'))).toBe(true);
    expect(isPrintable(k(' '))).toBe(true);
    expect(isPrintable(k('Shift'))).toBe(false);
    expect(isPrintable(k('a', { metaKey: true }))).toBe(false);
    expect(isPrintable(k('a', { ctrlKey: true }))).toBe(false);
  });

  it('batches typed characters into one text event after 300 ms idle; a flush sends at once', () => {
    let pending: { fn: () => void; ms: number } | null = null;
    const timers: Timers = {
      set: vi.fn((fn: () => void, ms: number) => {
        pending = { fn, ms };
        return 'id';
      }),
      clear: vi.fn(() => {
        pending = null;
      }),
    };
    const send = vi.fn();
    const b = createTextBatcher(send, timers);
    b.push('h');
    b.push('i');
    expect(send).not.toHaveBeenCalled();
    expect(timers.clear).toHaveBeenCalledTimes(1);
    expect(pending).not.toBeNull();
    expect(pending!.ms).toBe(300);
    pending!.fn();
    expect(send).toHaveBeenCalledWith('hi');
    // Nothing buffered: flush is a no-op.
    b.flush();
    expect(send).toHaveBeenCalledTimes(1);
    // A named key flushes what came before it, immediately.
    b.push('x');
    b.flush();
    expect(send).toHaveBeenLastCalledWith('x');
    // Dispose drops the buffer without sending.
    b.push('y');
    b.dispose();
    expect(send).toHaveBeenCalledTimes(2);
    expect(pending).toBeNull();
  });
});

describe('labels', () => {
  it('the frame URL carries the sequence number so every frame is fetched afresh', () => {
    expect(frameUrl(acme, 7)).toBe(`styx-device://frame/${acme}?seq=7`);
  });
  it('the device screen falls back to the phone preset until main measured it', () => {
    expect(deviceScreen(session())).toEqual({ width: 1179, height: 2556 });
    expect(deviceScreen(session({ screen: null }))).toEqual({ width: 393, height: 852 });
  });
  it('mirror modes read live · screenshots · no picture', () => {
    expect(mirrorModeLabel('window')).toBe(copy.workspace.device.mirrorWindow);
    expect(mirrorModeLabel('screenshots')).toBe(copy.workspace.device.mirrorScreenshots);
    expect(mirrorModeLabel('none')).toBe(copy.workspace.device.mirrorNone);
  });
  it.each([
    ['booting', session({ phase: 'booting' }), undefined, 'Booting iPhone 17 Pro…'],
    ['ready, main says screenshots', session(), undefined, 'Mirroring · iPhone 17 Pro · screenshots'],
    [
      'ready, the pane is showing the live window',
      session(),
      'window' as const,
      'Mirroring · iPhone 17 Pro · live',
    ],
    [
      'failed',
      session({ phase: 'failed', error: 'simctl boot exited 1' }),
      undefined,
      'Simulator failed: simctl boot exited 1',
    ],
    ['stopped', session({ phase: 'stopped' }), undefined, copy.workspace.device.stopped],
  ])('%s', (_name, s, mode, expected) => {
    expect(deviceRowText(s, mode)).toBe(expected);
  });
});
