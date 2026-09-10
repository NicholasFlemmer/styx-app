import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** Skills: list, browse the pinned catalogue, read one, install, remove. */
export function registerSkillsCommands(bus: CommandBus, app: Container): void {
  bus.register('skills.list', async ({ projectId }) => ({ skills: await app.skills.list(projectId) }));
  bus.register('skills.catalogue', async () => ({ skills: await app.skills.catalogue() }));
  bus.register('skills.preview', async ({ directory }) => app.skills.preview(directory));
  bus.register('skills.install', async (input) => ({ skill: await app.skills.install(input) }));
  bus.register('skills.remove', async (input) => {
    await app.skills.remove(input);
    return {};
  });
}
