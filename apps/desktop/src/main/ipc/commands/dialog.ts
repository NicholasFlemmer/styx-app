import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/**
 * dialog.* — native pickers live in main (the renderer never sees the filesystem). Under `STYX_E2E=1` the OS
 * dialog would hang a headless run, so the answer comes from `STYX_E2E_PICK` (unset = dismissed).
 */
export function registerDialogCommands(
  bus: CommandBus,
  app: Container,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const e2ePick = (): { path: string | null } | null =>
    env['STYX_E2E'] === '1' ? { path: env['STYX_E2E_PICK'] ?? null } : null;

  bus.register(
    'dialog.pickFolder',
    async (input) => e2ePick() ?? { path: await app.dialogs.pickFolder(input) },
  );

  bus.register('dialog.pickFile', async (input) => e2ePick() ?? { path: await app.dialogs.pickFile(input) });
}
