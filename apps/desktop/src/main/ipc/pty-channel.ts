import { CHANNELS } from '@styx/core';
import type { IpcMain, IpcMainEvent } from 'electron';
import { z } from 'zod';
import type { Container } from '../container';

const ptyInputSchema = z.object({
  id: z.string().min(1),
  data: z.string().optional(),
  resize: z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }).optional(),
});

/** Renderer → main bytes on the same `styx:pty` channel (`ipcMain.on`, not `handle`): `{ id, data }` or `{ id, resize }`. */
export function attachPtyChannel(ipcMain: IpcMain, app: Container): void {
  ipcMain.on(CHANNELS.pty, (event: IpcMainEvent, raw: unknown) => {
    if (
      !app.publisher.isRegistered(event.sender.id) ||
      !app.bus.originAllowed(event.senderFrame?.url ?? null)
    )
      return;
    const parsed = ptyInputSchema.safeParse(raw);
    if (!parsed.success) return;
    const { id, data, resize } = parsed.data;
    const isTerminal = app.terminals.isTerminal(id);
    if (data !== undefined) {
      if (isTerminal) app.pty.write(id, data);
      else app.sessions.ptyInput(id, data);
    }
    if (resize !== undefined) app.pty.resize(id, resize.cols, resize.rows);
  });
}
