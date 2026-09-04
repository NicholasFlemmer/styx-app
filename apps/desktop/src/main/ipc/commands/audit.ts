import type { CliInstall, IdeInstall } from '@styx/core';
import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** audit.* · detect.* · ide.* */
export function registerAuditCommands(bus: CommandBus, app: Container): void {
  const { repos, audit, publisher, detect, clock } = app;

  bus.register('audit.list', ({ cursor, limit, targetId, sessionId }) => {
    const entries = repos.audit.list({
      beforeSeq: cursor,
      limit,
      ...(targetId ? { targetId } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    const last = entries.at(-1);
    return { entries, nextCursor: entries.length === limit && last ? last.seq : null };
  });

  bus.register('audit.export', () => {
    const json = audit.exportJson();
    const row = audit.append({
      actorKind: 'you',
      actorLabel: 'you',
      action: 'exported',
      triggeredBy: 'settings',
      detail: { entries: repos.audit.all().length },
    });
    publisher.upsert('auditEntries', [row.id]);
    return { json };
  });

  bus.register('audit.verifyChain', () => {
    const r = audit.verifyChain();
    return r.ok ? { ok: true, brokenAtSeq: null } : { ok: false, brokenAtSeq: r.brokenAtSeq };
  });

  bus.register('detect.ides', async () => {
    const found = await detect.detectIdes();
    const now = clock.now();
    const fallback = repos.settings.app().fallbackIde;
    const prev = new Map(repos.discovery.ides().map((i) => [i.id, i]));
    const ides: IdeInstall[] = found
      .filter((i) => i.found)
      .map((i) => ({
        id: `ide-${i.kind}`,
        kind: i.kind,
        product: i.product,
        version: i.version,
        location: i.location,
        launcher: i.launcher,
        configDir: i.configDir,
        isFallback: i.kind === fallback,
        imported: prev.get(`ide-${i.kind}`)?.imported ?? {
          recents: Math.max(0, i.imports.recents),
          keybindings: false,
          theme: false,
        },
        detectedAt: now,
      }));
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

  // TODO(ide-import): read VS Code/Cursor `state.vscdb` recents, `keybindings.json` (minus RESERVED chords) and theme/font; JetBrains recentProjects.xml; Neovim shada.
  bus.register('ide.import', ({ ideId, keybindings, theme, recents }) => {
    const ide = repos.discovery.ides().find((i) => i.id === ideId);
    if (ide) {
      repos.discovery.saveIde({
        ...ide,
        imported: {
          recents: recents ? ide.imported.recents : ide.imported.recents,
          keybindings: ide.imported.keybindings || keybindings,
          theme: ide.imported.theme || theme,
        },
      });
      publisher.discoverySet(repos.discovery.ides(), repos.discovery.clis());
    }
    return { recents: [], keybindingsImported: 0, themeImported: false };
  });

  // TODO(open-in): register the `styx://open?path=` handler on PATH (`styx` launcher symlink / HKCU shell entry). The protocol itself is handled in index.ts.
  bus.register('ide.installOpenIn', () => ({}));

  bus.register('ide.setFallback', ({ kind }) => {
    const next = repos.settings.patch({ fallbackIde: kind });
    repos.discovery.setFallback(kind);
    publisher.settingsSet(next);
    publisher.discoverySet(repos.discovery.ides(), repos.discovery.clis());
    return {};
  });
}
