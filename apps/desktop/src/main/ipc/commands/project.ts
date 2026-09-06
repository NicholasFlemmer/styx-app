import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings, type SessionId } from '@styx/core';
import type { Container } from '../../container';
import { projectSettingsFor } from '../../store/projection';
import { type CommandBus, fail } from '../bus';

/** project.* */
export function registerProjectCommands(bus: CommandBus, app: Container): void {
  const { projects, repos } = app;

  bus.register('project.scan', async ({ includeIdeRecents }) => ({
    repos: await projects.scan(includeIdeRecents),
  }));

  bus.register('project.add', async ({ path, name }) => ({ projectId: (await projects.add(path, name)).id }));

  bus.register('project.gitInit', async ({ projectId }) => {
    await projects.gitInit(projectId);
    return {};
  });

  /** "Open in {IDE} too": the fallback IDE, else the app setting's kind; nothing when neither is detected. */
  const openInFallbackIde = (path: string): void => {
    const ide =
      repos.discovery.ides().find((i) => i.isFallback) ??
      repos.discovery.ides().find((i) => i.kind === repos.settings.app().fallbackIde);
    if (ide?.launcher) void app.openInIde(ide.launcher, path).catch(() => undefined);
  };

  bus.register('project.clone', async ({ url, into, openInIde }) => {
    const project = await projects.clone(url, into);
    if (openInIde) openInFallbackIde(project.path);
    return { projectId: project.id };
  });

  bus.register('project.create', async (input) => {
    const project = await projects.create({
      name: input.name,
      location: input.location,
      gitInit: input.gitInit,
      template: input.startFrom.kind === 'template' ? input.startFrom.template : null,
      copyTargetsFrom: input.copyTargetsFrom,
      createGithubRepo: input.createGithubRepo,
    });
    let sessionId: SessionId | null = null;
    if (input.startFrom.kind === 'agent') {
      const main = repos.worktrees.mainOf(project.id) ?? fail('internal', 'main worktree missing');
      const settings = projectSettingsFor(repos, project.id);
      const { session } = await app.sessions.spawn({
        projectId: project.id,
        agent: input.startFrom.agent,
        worktree: { kind: 'existing', worktreeId: main.id },
        firstMessage: `${input.startFrom.brief}\n\nScaffold the project skeleton in this empty worktree, then call ask_user(kind: "plan") before the first commit.`,
        toggles: {
          autoApproveEdits: settings.autoApproveEdits.value,
          mayRequestTargets: settings.mayRequestTargets.value,
          notifyWhenNeedsMe: settings.notifyWhenNeedsMe.value,
        },
        model: settings.model.value,
      });
      sessionId = session.id;
    }
    if (input.openInIde) openInFallbackIde(project.path);
    return { projectId: project.id, sessionId };
  });

  bus.register('project.templates', () => projects.templates());

  bus.register('project.remove', async ({ projectId, deleteFiles }) => {
    const { sessionIds } = await projects.remove(projectId, deleteFiles);
    for (const id of sessionIds) app.pty.kill(id);
    return {};
  });

  bus.register('project.reorder', ({ projectIds }) => {
    projects.reorder(projectIds);
    return {};
  });

  bus.register('project.select', ({ projectId }) => {
    projects.select(projectId);
    return {};
  });

  bus.register('project.settings.set', async ({ projectId, patch }) => {
    await projects.setSettings(projectId, patch as Partial<ProjectSettings>);
    return {};
  });

  bus.register('project.policy.accept', async ({ projectId, hash }) => {
    await projects.acceptPolicies(projectId, hash);
    return {};
  });

  bus.register('project.policy.pending', ({ projectId }) => projects.pendingPolicy(projectId));

  bus.register('project.settings.reset', async ({ projectId, key }) => {
    if (!(key in DEFAULT_PROJECT_SETTINGS)) fail('invalid-input', `unknown setting ${key}`);
    await projects.resetSetting(projectId, key);
    return {};
  });
}
