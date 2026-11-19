import {
  PROVIDER_LABEL,
  copy,
  fill,
  projectNameOf,
  rows,
  type Provider,
  type ReadModel,
  type Target,
} from '@styx/core';
import { Button } from '@styx/ui';
import { useModel, useUi } from '../../state/hooks';
import s from './One.module.css';

const identity = (m: ReadModel) => m;

/**
 * Connected apps (mockup frame 8): each app once, with the projects that use it. Today these are Styx's targets,
 * signed in the way the person already signs in; access lasts one task and every use is on the record.
 */
export function OneApps() {
  const model = useModel(identity);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const projectId = useUi((u) => u.projectId);
  const a = copy.one.apps;
  const byApp = new Map<Provider, Target[]>();
  for (const t of rows(model.targets))
    if (model.projects.byId[t.projectId]?.removedAt == null)
      byApp.set(t.provider, [...(byApp.get(t.provider) ?? []), t]);
  const reconnect = (t: Target) =>
    pushOverlay({
      kind: 'modal',
      modal: 'connect',
      projectId: t.projectId,
      provider: t.provider,
      targetId: t.id,
    });
  return (
    <div className={s['page']} data-one-page="apps">
      <div className={s['head']}>
        <h1 className={s['title']}>{a.title}</h1>
        {projectId === null ? null : (
          <Button
            variant="accent"
            size="regular"
            className={s['push']}
            onClick={() => pushOverlay({ kind: 'modal', modal: 'connect', projectId })}
          >
            {a.connect}
          </Button>
        )}
      </div>
      <p className={s['lead']}>{a.lead}</p>
      {byApp.size === 0 ? (
        <p className={s['empty']}>{a.none}</p>
      ) : (
        <ul className={s['lines']} aria-label={a.title}>
          {[...byApp].map(([provider, targets]) => {
            const signedOut = targets.find((t) => t.health !== 'ok');
            const projects = [...new Set(targets.map((t) => projectNameOf(model, t.projectId)))].join(', ');
            return (
              <li key={provider} className={s['appRow']} data-one-app={provider}>
                <span className={s['appName']}>
                  {PROVIDER_LABEL[provider]}
                  <span className={s['appSub']}>
                    {fill(a.usedBy, { projects })}
                    {targets.some((t) => t.env === 'prod') ? ` · ${a.production}` : ''}
                  </span>
                </span>
                <span className={s['needWhy']}>{signedOut === undefined ? a.connected : a.needsSignIn}</span>
                {signedOut === undefined ? (
                  <span />
                ) : (
                  <Button size="regular" onClick={() => reconnect(signedOut)}>
                    {a.signIn}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
