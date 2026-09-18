import type { Container } from '../../container';
import type { CommandBus } from '../bus';

/** run.* — the project's local dev server, started from the design window. */
export function registerRunCommands(bus: CommandBus, app: Container): void {
  bus.register('run.detect', ({ projectId }) => app.runs.detect(projectId));
  bus.register('run.start', ({ projectId, command, platform }) =>
    app.runs.start(projectId, command, platform === undefined ? {} : { platform }),
  );
  bus.register('run.stop', ({ projectId }) => {
    app.runs.stop(projectId);
    return {};
  });
  bus.register('run.dismiss', ({ projectId }) => {
    app.runs.dismiss(projectId);
    return {};
  });
}
