/**
 * Helpers for the short screen clips (e2e/readme/clips/*.clip.ts): each clip launches the built app over the demo
 * fixture, records the window as video, and walks one moment at a deliberate pace with a drawn pointer (recorded
 * video has none). Alongside the video it writes the moment's beats (named points in time), so whoever edits the
 * video can place words or cut it without guessing.
 *
 *   pnpm -F @styx/desktop build
 *   node --experimental-strip-types e2e/run.ts --project clips [--grep tasks-board]
 *
 * Output: $STYX_CLIPS_OUT (default test-results/clips): <name>.webm and <name>.json
 * ({ name, size, scale, beats: [{ id, msBeforeEnd, focus? }] }; size in CSS pixels, the video is size × scale; `focus`
 * is the box of what the beat is about, so an editor can frame it). Beats are
 * measured back from the end of the recording, which is when the window closes, because the start of an Electron
 * recording is not observable from the test.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { launchStyx, type LaunchOptions } from '../../launch';

/** The window, in CSS pixels. */
export const CLIP_SIZE = { width: 1280, height: 800 };
/** Device pixels per CSS pixel in the recording: 2 keeps text sharp when the frame is scaled up for a phone. */
export const CLIP_SCALE = Number(process.env['STYX_CLIPS_SCALE'] ?? 2);
export const CLIPS_OUT = resolve(
  process.env['STYX_CLIPS_OUT'] ?? resolve(__dirname, '../../../test-results/clips'),
);

export interface Scene {
  app: ElectronApplication;
  page: Page;
  /** Marks a named point in the clip (the start of a step), and where on screen the step happens. */
  beat: (id: string, focus?: Locator) => Promise<void>;
  /** Rest for a while, so a viewer can read what's on screen. */
  hold: (ms: number) => Promise<void>;
  /** Glide the pointer to the middle of `target`, rest, click. */
  click: (target: Locator, restMs?: number) => Promise<void>;
  /** Glide the pointer to a point. */
  moveTo: (x: number, y: number, steps?: number) => Promise<void>;
  /** Type text at a person's pace. */
  type: (target: Locator, text: string, delayMs?: number) => Promise<void>;
  /** Close the app and write the video and its beats. */
  finish: () => Promise<{ video: string; beats: string }>;
}

/** A pointer and a click ripple, drawn in the page. */
export const drawPointer = (page: Page) =>
  page.evaluate(() => {
    if (document.getElementById('clip-pointer')) return;
    const p = document.createElement('div');
    p.id = 'clip-pointer';
    p.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 13.8 L10.5 20 L13.2 18.8 L10.3 12.6 L16.5 12.6 Z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(p.style, {
      position: 'fixed',
      left: '640px',
      top: '420px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transform: 'translate(-3px,-2px)',
      transition: 'none',
    });
    document.body.appendChild(p);
    document.addEventListener(
      'mousemove',
      (e) => {
        p.style.left = `${e.clientX}px`;
        p.style.top = `${e.clientY}px`;
      },
      true,
    );
    document.addEventListener(
      'mousedown',
      (e) => {
        const r = document.createElement('div');
        Object.assign(r.style, {
          position: 'fixed',
          left: `${e.clientX - 14}px`,
          top: `${e.clientY - 14}px`,
          width: '28px',
          height: '28px',
          border: '2px solid #d6ff3d',
          borderRadius: '50%',
          zIndex: '2147483646',
          pointerEvents: 'none',
          transition: 'transform 380ms ease-out, opacity 380ms ease-out',
        });
        document.body.appendChild(r);
        requestAnimationFrame(() => {
          r.style.transform = 'scale(1.9)';
          r.style.opacity = '0';
        });
        setTimeout(() => r.remove(), 420);
      },
      true,
    );
  });

/** Launches the app for a clip named `name` and returns the scene controls. */
export async function startScene(name: string, opts: LaunchOptions = {}): Promise<Scene> {
  mkdirSync(CLIPS_OUT, { recursive: true });
  const raw = join(CLIPS_OUT, `.raw-${name}`);
  const { app, page } = await launchStyx({
    theme: 'dark',
    chrome: 'mac',
    ...opts,
    env: { STYX_MFA: 'auto', STYX_DEMO_REPOS: '0', ...opts.env },
    scaleFactor: CLIP_SCALE,
    recordVideo: {
      dir: raw,
      size: { width: CLIP_SIZE.width * CLIP_SCALE, height: CLIP_SIZE.height * CLIP_SCALE },
    },
  });
  type Box = { x: number; y: number; width: number; height: number };
  const marks: { id: string; at: number; focus?: Box }[] = [];
  let pointer = { x: 640, y: 420 };

  const moveTo = async (x: number, y: number, steps = 28) => {
    await drawPointer(page);
    await page.mouse.move(x, y, { steps });
    pointer = { x, y };
  };
  const scene: Scene = {
    app,
    page,
    beat: async (id, focus) => {
      const at = Date.now();
      const box = focus ? await focus.boundingBox() : null;
      const round = (n: number) => Math.round(n);
      marks.push({
        id,
        at,
        ...(box
          ? {
              focus: { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) },
            }
          : {}),
      });
    },
    hold: (ms) => page.waitForTimeout(ms),
    moveTo,
    click: async (target, restMs = 350) => {
      const box = await target.boundingBox();
      if (!box) throw new Error('clip: target not on screen');
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      // Longer glides for longer distances, so the pointer moves at an even speed.
      const steps = Math.max(12, Math.min(40, Math.round(Math.hypot(x - pointer.x, y - pointer.y) / 18)));
      await moveTo(x, y, steps);
      await page.waitForTimeout(restMs);
      await page.mouse.down();
      await page.mouse.up();
    },
    type: async (target, text, delayMs = 45) => {
      await target.pressSequentially(text, { delay: delayMs });
    },
    finish: async () => {
      const video = page.video();
      const end = Date.now();
      await app.close();
      if (!video) throw new Error('clip: no video was recorded');
      const out = join(CLIPS_OUT, `${name}.webm`);
      renameSync(await video.path(), out);
      rmSync(raw, { recursive: true, force: true });
      const beats = join(CLIPS_OUT, `${name}.json`);
      writeFileSync(
        beats,
        `${JSON.stringify({ name, size: CLIP_SIZE, scale: CLIP_SCALE, beats: marks.map((m) => ({ id: m.id, msBeforeEnd: end - m.at, ...(m.focus ? { focus: m.focus } : {}) })) }, null, 2)}\n`,
      );
      return { video: out, beats };
    },
  };
  return scene;
}
