import { reportPage } from '../../services/report-page';
import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/**
 * Connected apps (ADR-0033 tier 2). Only the person adds, signs in to or removes an app; agents have no command for
 * any of it and reach an app only through the broker's `use_app`, which asks before a change.
 */
export function registerConnectedAppsCommands(bus: CommandBus, app: Container): void {
  bus.register(
    'connectedApps.add',
    async ({ name, url, projectId, clientId, clientSecret, issuer, token, header }) => {
      if (clientId !== '' && token !== '') throw new Error('Use a client ID, or a key: not both.');
      // Advanced: a key or token; or the person's own OAuth client; else Styx registers itself at sign-in.
      return {
        appId:
          token !== ''
            ? await app.connectedApps.addWithKey(name, url, header, token, projectId)
            : await app.connectedApps.add(
                name,
                url,
                projectId,
                clientId === '' ? null : { id: clientId, secret: clientSecret, issuer },
              ),
      };
    },
  );
  bus.register('connectedApps.addMetaAds', async ({ token, adAccount, projectId }) => ({
    appId: await app.connectedApps.addMetaAds(token, adAccount, projectId),
  }));
  bus.register('connectedApps.signIn', ({ appId }) => {
    if (!app.connectedApps.current().some((a) => a.id === appId))
      throw new Error('That app is not connected.');
    // The browser sign-in can take minutes; the list shows its progress and any error.
    void app.connectedApps.signIn(appId).catch(() => undefined);
    return {};
  });
  bus.register('connectedApps.setProjects', ({ appId, projectIds }) => {
    app.connectedApps.setProjects(appId, projectIds);
    return {};
  });
  bus.register('taskResults.approveLaunch', async ({ sessionId, ...approval }) => {
    await app.taskResults.approveLaunch(sessionId, approval);
    return {};
  });
  bus.register('taskResults.adImage', async ({ sessionId, index }) => ({
    dataUrl: await app.taskResults.adImage(sessionId, index),
  }));
  bus.register('taskResults.setWeekly', ({ sessionId, weekly }) => {
    app.reportSchedule.setWeekly(sessionId, weekly);
    return {};
  });
  bus.register('taskResults.pdf', async ({ sessionId }) => {
    const r = app.repos.taskResults.get(sessionId);
    if (r?.body.kind !== 'report') throw new Error('That task has no report.');
    const save = app.dialogs.savePdf;
    if (save === undefined) return { path: null };
    const html = reportPage({
      report: r.body,
      project: app.repos.projects.get(r.projectId)?.name ?? '',
      sharedBy: '',
      updated: new Date(r.updatedAt).toLocaleString('en-GB'),
      css: 'inline',
    });
    const name = `${r.body.title}${r.body.period === undefined ? '' : ` ${r.body.period}`}`
      .replace(/[^\w .,-]+/g, '')
      .slice(0, 80);
    return { path: await save(html, `${name || 'Report'}.pdf`) };
  });
  bus.register('taskResults.pauseAll', async ({ sessionId }) => {
    await app.taskResults.pauseAll(sessionId);
    return {};
  });
  bus.register('taskResults.live', async ({ sessionId }) => ({
    live: await app.taskResults.live(sessionId),
  }));
  bus.register('connectedApps.remove', async ({ appId }) => {
    await app.connectedApps.remove(appId);
    return {};
  });
}
