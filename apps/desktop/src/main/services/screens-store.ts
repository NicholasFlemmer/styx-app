import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Which side of a turn a checkpoint screenshot shows. */
export type ScreenSide = 'before' | 'after';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

/**
 * Pictures of the running app, served to the renderer over `styx-device://` (the renderer's CSP allows no
 * `file:` images, and a picture must never travel through the store deltas):
 *
 * - live frames of a mirrored device in screenshots mode, in memory, one per project, replaced as they arrive
 *   (`styx-device://frame/<projectId>?seq=<n>`; the seq only defeats the image cache);
 * - checkpoint screenshots on disk under `<userData>/screens/<checkpointId>-<side>.png`
 *   (`styx-device://checkpoint/<checkpointId>/<side>`), kept with the checkpoint row and pruned with it.
 *
 * Keys are validated so a URL can never reach outside the screens directory.
 */
export class ScreensStore {
  private readonly frames = new Map<string, { png: Buffer; seq: number }>();

  constructor(private readonly dir: string) {}

  // --- live frames ---------------------------------------------------------

  /** Stores the latest frame for a project and returns its sequence number. */
  putFrame(projectId: string, png: Buffer): number {
    const seq = (this.frames.get(projectId)?.seq ?? 0) + 1;
    this.frames.set(projectId, { png, seq });
    return seq;
  }

  frame(projectId: string): Buffer | null {
    return this.frames.get(projectId)?.png ?? null;
  }

  dropFrame(projectId: string): void {
    this.frames.delete(projectId);
  }

  // --- checkpoint screenshots ---------------------------------------------

  async putScreen(checkpointId: string, side: ScreenSide, png: Buffer): Promise<void> {
    const file = this.screenPath(checkpointId, side);
    if (file === null) return;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    await writeFile(file, png);
  }

  async screen(checkpointId: string, side: ScreenSide): Promise<Buffer | null> {
    const file = this.screenPath(checkpointId, side);
    if (file === null) return null;
    return readFile(file).catch(() => null);
  }

  async dropScreens(checkpointId: string): Promise<void> {
    for (const side of ['before', 'after'] as const) {
      const file = this.screenPath(checkpointId, side);
      if (file !== null) await rm(file, { force: true }).catch(() => undefined);
    }
  }

  /** Resolves a `styx-device://<host>/<path>` request to bytes; null = not found (the handler answers 404). */
  async resolve(url: string): Promise<Buffer | null> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    const parts = u.pathname.split('/').filter((p) => p !== '');
    if (u.host === 'frame') {
      const projectId = parts[0];
      return projectId !== undefined && SAFE_ID.test(projectId) ? this.frame(projectId) : null;
    }
    if (u.host === 'checkpoint') {
      const [id, side] = parts;
      if (id === undefined || (side !== 'before' && side !== 'after')) return null;
      return this.screen(id, side);
    }
    return null;
  }

  private screenPath(checkpointId: string, side: ScreenSide): string | null {
    if (!SAFE_ID.test(checkpointId)) return null;
    return join(this.dir, `${checkpointId}-${side}.png`);
  }
}
