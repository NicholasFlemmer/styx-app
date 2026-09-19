import { copy } from '@styx/core';
import type { DeviceSession, ProjectId } from '@styx/core';
import { useEffect, useRef, useState } from 'react';
import { onEvent } from '../../state/bridge';
import { command } from '../../state/commands';
import { MIRROR_HEARTBEAT_MS } from './device-mirror';

export interface MirrorState {
  /** What the pane is showing; null until main answered `device.mirror`. */
  mode: DeviceSession['mirror'] | null;
  /** Why the mirror is not live (Screen Recording not granted, window not found …). */
  reason: string | null;
  /** The simulator window's capture in `window` mode. */
  stream: MediaStream | null;
  /** The latest `device.frame` sequence in `screenshots` mode; 0 before the first frame. */
  seq: number;
}

/** One `device.mirror` answer. Identical answers keep the same object, so a heartbeat never re-captures. */
interface Answer {
  mode: DeviceSession['mirror'];
  reason: string | null;
}

const same = (a: Answer | null, b: Answer): boolean =>
  a !== null && a.mode === b.mode && a.reason === b.reason;

const canCapture = (): boolean =>
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

const stopStream = (stream: MediaStream): void => {
  for (const t of stream.getTracks()) t.stop();
};

/**
 * How the mirrored device reaches the pane. `device.mirror` is asked once the session is ready and every 30 s
 * while the pane is showing (main keeps the screenshot poller alive on that heartbeat). `window` means main armed
 * the simulator's window for exactly one `getDisplayMedia` call — the OS picker never opens — so each such
 * answer is captured once, and the capture lives exactly as long as that answer: a changed answer, leaving the
 * pane, the session ending or unmounting release it. When the stream ends on its own (the simulator was closed,
 * the permission changed) main is asked again rather than the capture retried blind. `screenshots` means frames
 * arrive as `device.frame` events and are read back over `styx-device://`.
 */
export const useDeviceMirror = (projectId: ProjectId, ready: boolean, active: boolean): MirrorState => {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  // Read by the heartbeat's interval closure, which outlives any one render.
  const answerRef = useRef<Answer | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  useEffect(() => {
    answerRef.current = answer;
    streamRef.current = stream;
  }, [answer, stream]);
  const [seq, setSeq] = useState(0);
  // Bumped when a stream ends so main is asked again (a fresh arm, a fresh capture).
  const [attempt, setAttempt] = useState(0);
  const live = ready && active;

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const ask = async () => {
      const r = await command('device.mirror', { projectId });
      if (cancelled) return;
      const next: Answer = !r.ok
        ? { mode: 'none', reason: r.error.message }
        : r.value.mode === 'window' && !canCapture()
          ? { mode: 'none', reason: copy.workspace.device.noCapture }
          : { mode: r.value.mode, reason: r.value.reason };
      setAnswer((prev) => (same(prev, next) ? prev : next));
    };
    void ask();
    // The heartbeat keeps main's screenshot poller alive; a live capture needs no keeping (and re-arming the
    // window every 30 s would leave an arm lying around for anything else to collect).
    const id = setInterval(() => {
      if (answerRef.current?.mode === 'window' && streamRef.current !== null) return;
      void ask();
    }, MIRROR_HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      // Not looking any more (or asking afresh): the next answer starts clean.
      setAnswer(null);
    };
  }, [projectId, live, attempt]);

  // A `window` answer: take the one window main armed, and keep it for as long as this answer stands.
  useEffect(() => {
    if (!live || answer === null || answer.mode !== 'window') return;
    let cancelled = false;
    let got: MediaStream | null = null;
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then(
      (s) => {
        if (cancelled) {
          stopStream(s);
          return;
        }
        got = s;
        setStream(s);
      },
      (e: unknown) => {
        if (cancelled) return;
        setAnswer({ mode: 'none', reason: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
      if (got !== null) stopStream(got);
      setStream(null);
    };
  }, [live, answer]);

  // The capture ended on its own (simulator closed, permission revoked): ask main again.
  useEffect(() => {
    if (stream === null) return;
    const ended = () => setAttempt((a) => a + 1);
    const track = stream.getVideoTracks()[0];
    stream.addEventListener('inactive', ended);
    track?.addEventListener('ended', ended);
    return () => {
      stream.removeEventListener('inactive', ended);
      track?.removeEventListener('ended', ended);
    };
  }, [stream]);

  // Frames, for as long as the session is ready; a session that went away starts from nothing.
  useEffect(() => {
    if (!ready) return;
    const off = onEvent('device.frame', (p) => {
      if (p.projectId === projectId) setSeq(p.seq);
    });
    return () => {
      off();
      setSeq(0);
    };
  }, [projectId, ready]);

  return { mode: answer?.mode ?? null, reason: answer?.reason ?? null, stream, seq };
};
