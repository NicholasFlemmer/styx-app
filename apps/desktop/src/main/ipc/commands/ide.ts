import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type { CliInstall, IdeInstall } from '@styx/core';
import type { Container } from '../../container';
import { installOpenIn, type OpenInInstallDeps } from '../../services/ide-import-service';
import { logger } from '../../services/logger';
import type { CommandBus } from '../bus';

/** app_settings keys for imported editor preferences (read by the renderer's key registry / editor theme). */
export const IMPORTED_KEYBINDINGS_KEY = 'editor.importedKeybindings';
export const IMPORTED_THEME_KEY = 'editor.importedTheme';

/** detect.* · ide.* */
export function registerIdeCommands(bus: CommandBus, app: Container): void {
  const { repos, publisher, detect, ideImport, clock, runtime } = app;

  bus.register('detect.ides', async () => {
    const found = await detect.detectIdes();
    const now = clock.now();
    const fallback = repos.settings.app().fallbackIde;
    const prev = new Map(repos.discovery.ides().map((i) => [i.id, i]));
    const ides: IdeInstall[] = found
      .filter((i) => i.found)
      .map((i) => {
        const before = prev.get(`ide-${i.kind}`);
        const recents = ideImport.recentFolders({ kind: i.kind, configDir: i.configDir }).length;
        return {
          id: `ide-${i.kind}`,
          kind: i.kind,
          product: i.product,
          version: i.version,
          location: i.location,
          launcher: i.launcher,
          configDir: i.configDir,
          isFallback: i.kind === fallback,
          imported: {
            recents: Math.max(recents, i.imports.recents, 0),
            keybindings: before?.imported.keybindings ?? false,
            theme: before?.imported.theme ?? false,
          },
          detectedAt: now,
        };
      });
    repos.discovery.replaceIdes(ides);
    publisher.discoverySet(ides, repos.discovery.clis());
    return { ides };
  });

  bus.register('detect.clis', async () => {
    const found = await detect.detectClis();
    const now = clock.now();
    const clis: CliInstall[] = found.map((c) => ({
      agent: c.agent,
      binary: c.binary,
      version: c.version,
      found: c.found,
      authState: c.authState,
      capabilities: c.capabilities,
      checkedAt: now,
    }));
    repos.discovery.replaceClis(clis);
    publisher.discoverySet(repos.discovery.ides(), clis);
    return { clis };
  });

  /**
   * Imports from one detected editor (spec §4.9 Editor step). Recents come back as scan rows for the Projects step;
   * keybindings / theme+font are stored under `editor.imported*` in app_settings. Nothing secret is read.
   */
  bus.register('ide.import', async ({ ideId, keybindings, theme, recents }) => {
    const ide = repos.discovery.ides().find((i) => i.id === ideId);
    if (!ide) return { recents: [], keybindingsImported: 0, themeImported: false };
    const r = ideImport.importFrom(
      { kind: ide.kind, configDir: ide.configDir },
      { recents, keybindings, theme },
    );
    if (r.keybindings) repos.settings.kv.set(IMPORTED_KEYBINDINGS_KEY, r.keybindings);
    const themeImported = r.theme !== null && (r.theme.colorTheme !== null || r.theme.fontFamily !== null);
    if (themeImported) repos.settings.kv.set(IMPORTED_THEME_KEY, { ...r.theme, from: ide.kind });
    const rows = await app.projects.describeRepos(r.recents.map((path) => ({ path, source: 'ide-recent' as const })));
    repos.discovery.saveIde({
      ...ide,
      imported: {
        recents: recents ? r.recents.length : ide.imported.recents,
        keybindings: ide.imported.keybindings || (r.keybindings?.length ?? 0) > 0,
        theme: ide.imported.theme || themeImported,
      },
    });
    publisher.discoverySet(repos.discovery.ides(), repos.discovery.clis());
    return { recents: rows, keybindingsImported: r.keybindings?.length ?? 0, themeImported };
  });

  /** `styx` launcher on PATH (+ Windows Explorer verb) → `styx://open?path=`, handled in index.ts. */
  bus.register('ide.installOpenIn', async () => {
    const deps: OpenInInstallDeps = {
      platform: runtime.platform,
      home: homedir(),
      env: process.env,
      launcherDir: join(runtime.userData, 'open-in'),
      exec: async (bin, args) => {
        const r = await execa(bin, args, { reject: false, timeout: 15_000, windowsHide: true });
        return { exitCode: r.exitCode ?? 1, stdout: String(r.stdout ?? '') };
      },
      writeFile: (p, body, mode) => {
        writeFileSync(p, body);
        if (mode !== undefined && runtime.platform !== 'win32') chmodSync(p, mode);
      },
      mkdir: (p) => mkdirSync(p, { recursive: true }),
      symlink: (target, link) => symlinkSync(target, link),
      exists: (p) => existsSync(p),
      remove: (p) => rmSync(p, { force: true }),
    };
    const r = await installOpenIn(deps);
    logger.info('open-in installed', { at: r.installedAt, hint: r.pathHint });
    return {};
  });

  bus.register('ide.setFallback', ({ kind }) => {
    const next = repos.settings.patch({ fallbackIde: kind });
    repos.discovery.setFallback(kind);
    publisher.settingsSet(next);
    publisher.discoverySet(repos.discovery.ides(), repos.discovery.clis());
    return {};
  });
}
