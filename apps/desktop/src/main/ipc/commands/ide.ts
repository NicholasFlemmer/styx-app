import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { execa } from 'execa';
import { cliAlternatives, copy, fill, type Agent, type IdeInstall } from '@styx/core';
import type { Container } from '../../container';
import { toCliInstall, type CliProblem } from '../../services/detect-service';
import { installOpenIn, type OpenInInstallDeps } from '../../services/ide-import-service';
import { logger } from '../../services/logger';
import { cliBinaryKey } from '../../services/session-service';
import { type CommandBus, fail } from '../bus';

/** app_settings keys for imported editor preferences (read by the renderer's key registry / editor theme). */
export const IMPORTED_KEYBINDINGS_KEY = 'editor.importedKeybindings';
export const IMPORTED_THEME_KEY = 'editor.importedTheme';
export { CLI_BINARY_KEY_PREFIX, cliBinaryKey } from '../../services/session-service';

/** Where each IDE keeps its recent folders (spec §4.9: VS Code/Cursor state.vscdb, JetBrains recentProjects.xml, Neovim shada). */
const RECENTS_SOURCE = {
  vscode: 'state-db',
  cursor: 'state-db',
  windsurf: 'state-db',
  /** Zed keeps its workspaces in its own SQLite store, not read in this version. */
  zed: null,
  jetbrains: 'recent-projects',
  neovim: 'shada',
} as const;

/** The human reason a "Locate binary" pick was refused; shown inline where the pick was made. */
const locateFailure = (
  agent: Exclude<Agent, 'shell'>,
  path: string,
  problem: CliProblem | undefined,
): string => {
  const cli = copy.agentProducts[agent];
  const f = copy.errors.locateBinaryFailed;
  switch (problem?.kind) {
    case 'directory':
      return fill(f.directory, { path, cli });
    case 'other-agent':
      return fill(f.otherAgent, { path, cli, other: copy.agentProducts[problem.agent] });
    case 'not-runnable':
    case undefined:
      return fill(f.notRunnable, { path, cli });
  }
};

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
          recentsSource: RECENTS_SOURCE[i.kind],
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

  /** Every candidate (PATH, IDE extension bundles, manual pick) is probed; a located binary outranks the best one. */
  bus.register('detect.clis', async () => ({ clis: await app.sessions.refreshClis() }));

  bus.register('detect.setBinary', async ({ agent, path: given }) => {
    if (agent === 'shell') fail('invalid-input', 'the shell agent has no binary to locate');
    // `~/…` and a bare command name are typed into the Connect modal's path field (#98): the shell's PATH resolves
    // the name; anything else must already be absolute.
    const expanded = given === '~' || given.startsWith('~/') ? join(homedir(), given.slice(2)) : given;
    const path = isAbsolute(expanded)
      ? expanded
      : /[\\/]/.test(expanded)
        ? fail('invalid-input', 'the binary path must be absolute')
        : ((await detect.resolveName(expanded)) ??
          fail('not-found', fill(copy.agentsPage.connect.notOnPath, { name: expanded })));
    if (!existsSync(path)) fail('not-found', `${path} does not exist`);
    // The pick has to run, report a version and be this agent's CLI, or it is refused with the reason: a file that
    // merely exists would otherwise hide detection and leave nothing to retry with.
    const probed = await detect.probe(agent, path);
    if (!probed.found)
      fail('invalid-input', locateFailure(agent, path, probed.problem), { problem: probed.problem ?? null });
    const file = probed.binary ?? path; // an .app bundle resolves to the CLI inside it
    repos.settings.kv.set(cliBinaryKey(agent), file);
    // The other candidates stay listed so the Settings Select can switch back to them.
    const previous = repos.discovery.cli(agent);
    const rest = (previous === null ? [] : cliAlternatives(previous)).filter(
      (c) => c.binary !== file && c.source !== 'manual',
    );
    const cli = toCliInstall(
      { ...probed, alternatives: [{ binary: file, version: probed.version, source: 'manual' }, ...rest] },
      clock.now(),
    );
    repos.discovery.saveCli(cli);
    publisher.discoverySet(repos.discovery.ides(), repos.discovery.clis());
    return { cli };
  });

  /** Undo "Locate binary": the manual pick is forgotten and detection runs again on PATH and the bundles. */
  bus.register('detect.clearBinary', async ({ agent }) => {
    if (agent === 'shell') fail('invalid-input', 'the shell agent has no binary to forget');
    repos.settings.kv.delete(cliBinaryKey(agent));
    detect.invalidate();
    const clis = await app.sessions.refreshClis();
    const cli = clis.find((c) => c.agent === agent) ?? fail('not-found', `${agent} was not detected`);
    // refreshClis only publishes on change; the manual → detected switch always is one, but be explicit.
    publisher.discoverySet(repos.discovery.ides(), repos.discovery.clis());
    return { cli };
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
    const rows = await app.projects.describeRepos(
      r.recents.map((path) => ({ path, source: 'ide-recent' as const })),
    );
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
