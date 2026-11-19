import {
  APP_CATALOGUE,
  PROVIDER_LABEL,
  catalogueEntryFor,
  copy,
  fill,
  projectNameOf,
  rows,
  type CatalogueApp,
  type CatalogueGroup,
  type ConnectedApp,
  type ProjectId,
  type Provider,
  type ReadModel,
  type Target,
} from '@styx/core';
import { Button } from '@styx/ui';
import { useEffect, useRef, useState } from 'react';
import { command } from '../../state/commands';
import { useModel, useUi } from '../../state/hooks';
import { AppLogo } from './AppLogo';
import { AddApp, MetaAds, UsedIn } from './ConnectedAppsMcp';
import s from './One.module.css';

const identity = (m: ReadModel) => m;

type Tab = 'all' | 'connected' | CatalogueGroup;
const TABS: Tab[] = ['all', 'connected', 'marketing', 'sales', 'work', 'money', 'dev'];

/** What the panel under the cards shows: a connected app's details, the Meta form, or Add your own. */
type Panel = { kind: 'app'; id: string } | { kind: 'meta' } | { kind: 'own' } | null;

/** One card: the catalogue's view of an app, joined with what is connected. */
interface Card {
  key: string;
  logo: string;
  name: string;
  blurb: string;
  group: CatalogueGroup | 'custom';
  entry: CatalogueApp | null;
  connected: ConnectedApp | null;
  /** Code hosting already connected as Styx targets, by provider. */
  targets: Target[];
}

const cardsOf = (model: ReadModel): Card[] => {
  const apps = model.connectedApps;
  const targets = rows(model.targets).filter((t) => model.projects.byId[t.projectId]?.removedAt == null);
  const used = new Set<string>();
  const cards: Card[] = APP_CATALOGUE.map((entry) => {
    const connected =
      apps.find((a) =>
        entry.id === 'meta-ads' ? a.kind === 'meta-ads' : catalogueEntryFor(a.url)?.id === entry.id,
      ) ?? null;
    if (connected !== null) used.add(connected.id);
    return {
      key: entry.id,
      logo: entry.id,
      name: entry.name,
      blurb: entry.blurb,
      group: entry.group,
      entry,
      connected,
      targets: targets.filter((t) => t.provider === entry.id),
    };
  });
  // Apps added by address that the catalogue does not name.
  for (const a of apps)
    if (!used.has(a.id))
      cards.push({
        key: a.id,
        logo: a.id,
        name: a.name,
        blurb: a.url,
        group: 'custom',
        entry: null,
        connected: a,
        targets: [],
      });
  // Code hosting connected as targets that the catalogue has no card for (AWS, GCP, Fly, Railway, Render, SSH).
  const byProvider = new Map<Provider, Target[]>();
  for (const t of targets)
    if (!APP_CATALOGUE.some((e) => e.id === t.provider))
      byProvider.set(t.provider, [...(byProvider.get(t.provider) ?? []), t]);
  for (const [provider, list] of byProvider)
    cards.push({
      key: `target-${provider}`,
      logo: provider,
      name: PROVIDER_LABEL[provider],
      blurb: copy.one.apps.hosting,
      group: 'dev',
      entry: null,
      connected: null,
      targets: list,
    });
  return cards;
};

const isConnected = (c: Card) => c.connected?.status === 'connected' || c.targets.length > 0;

/**
 * Connected apps (mockup frame 8): every app as a card with its mark, grouped by what it is for. One click for apps
 * with an open connection; Meta Ads built in; Add your own for anything else with an MCP address. Code hosting
 * connected as Styx targets shows here too, said plainly.
 */
export function OneApps() {
  const model = useModel(identity);
  const projectId = useUi((u) => u.projectId);
  const pushOverlay = useUi((u) => u.pushOverlay);
  const [tab, setTab] = useState<Tab>('all');
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelKey = panel === null ? '' : panel.kind === 'app' ? panel.id : panel.kind;
  useEffect(() => {
    if (panelKey === '') return;
    panelRef.current?.scrollIntoView?.({ block: 'start' });
    panelRef.current?.focus({ preventScroll: true });
  }, [panelKey]);
  const a = copy.one.apps;
  const cards = cardsOf(model).filter((c) =>
    tab === 'all' ? true : tab === 'connected' ? isConnected(c) || c.connected !== null : c.group === tab,
  );
  const connect = async (c: Card) => {
    setError(null);
    if (c.entry?.access === 'built-in') {
      setPanel({ kind: 'meta' });
      return;
    }
    if (c.entry?.url == null) return;
    const r = await command('connectedApps.add', { name: c.entry.name, url: c.entry.url, projectId });
    if (!r.ok) setError(r.error.message);
    else setPanel({ kind: 'app', id: r.value.appId });
  };
  const shown = panel?.kind === 'app' ? model.connectedApps.find((x) => x.id === panel.id) : undefined;
  return (
    <div className={s['page']} data-one-page="apps">
      <div className={s['head']}>
        <h1 className={s['title']}>{a.title}</h1>
      </div>
      <p className={s['lead']}>{a.lead}</p>
      <div className={s['filters']} role="group" aria-label={a.title}>
        {TABS.map((t) => (
          <Button key={t} inv={tab === t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {a.tabs[t]}
          </Button>
        ))}
      </div>
      {error === null ? null : (
        <p className={s['askError']} role="alert">
          {error}
        </p>
      )}
      {/* What Manage, Connect Meta Ads or Add your own opened: at the top, scrolled to, focused. */}
      <div ref={panelRef} tabIndex={-1} className={s['panelSlot']} aria-live="polite">
        {panel?.kind === 'own' ? (
          <section className={s['box']} aria-label={a.own}>
            <h2 className={s['h3']}>{a.own}</h2>
            <p className={s['lead']}>{a.mcpLead}</p>
            <AddApp />
          </section>
        ) : null}
        {panel?.kind === 'meta' ? (
          <section className={s['box']} aria-label={a.meta.name}>
            <MetaAds />
          </section>
        ) : null}
        {shown !== undefined ? <AppDetail app={shown} onClose={() => setPanel(null)} /> : null}
      </div>
      <ul className={s['appCards']} aria-label={a.title}>
        {cards.map((c) => (
          <li key={c.key}>
            <AppCard
              card={c}
              model={model}
              open={
                (panel?.kind === 'app' && c.connected?.id === panel.id) ||
                (panel?.kind === 'meta' && c.entry?.access === 'built-in')
              }
              onConnect={() => void connect(c)}
              onOpen={() => {
                if (c.connected !== null) setPanel({ kind: 'app', id: c.connected.id });
                else if (c.targets[0] !== undefined && c.targets.some((t) => t.health !== 'ok')) {
                  const t = c.targets.find((x) => x.health !== 'ok') ?? c.targets[0];
                  pushOverlay({
                    kind: 'modal',
                    modal: 'connect',
                    projectId: t.projectId,
                    provider: t.provider,
                    targetId: t.id,
                  });
                }
              }}
            />
          </li>
        ))}
        {tab === 'all' || tab === 'connected' ? (
          <li>
            <button
              type="button"
              className={s['appCardOwn']}
              aria-expanded={panel?.kind === 'own'}
              onClick={() => setPanel(panel?.kind === 'own' ? null : { kind: 'own' })}
              data-one-app-own="true"
            >
              <span className={s['ownPlus']} aria-hidden="true">
                +
              </span>
              <b>{a.own}</b>
              <span className={s['needWhy']}>{a.ownLead}</span>
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function AppCard({
  card,
  model,
  open,
  onConnect,
  onOpen,
}: {
  card: Card;
  model: ReadModel;
  open: boolean;
  onConnect: () => void;
  onOpen: () => void;
}) {
  const a = copy.one.apps;
  const c = card.connected;
  const projects = [
    ...new Set(
      [...(c?.projects ?? []), ...card.targets.map((t) => t.projectId)].map((p) =>
        projectNameOf(model, p as ProjectId),
      ),
    ),
  ].filter((n) => n !== '');
  const status =
    c !== null
      ? c.status === 'connected'
        ? projects.length === 0
          ? a.noProjectsYet
          : fill(a.usedByShort, { projects: projects.join(', ') })
        : a.status[c.status]
      : card.targets.length > 0
        ? card.targets.some((t) => t.health !== 'ok')
          ? a.needsSignIn
          : fill(a.usedByShort, { projects: projects.join(', ') })
        : (card.entry?.note ?? null);
  return (
    <div className={s['appCard']} data-on={open ? 'true' : undefined} data-one-app-card={card.key}>
      <div className={s['appCardHead']}>
        <AppLogo id={card.logo} name={card.name} />
        <span className={s['appCardName']}>
          <b>{card.name}</b>
          <span className={s['needWhy']}>{card.blurb}</span>
        </span>
      </div>
      {status === null ? null : <span className={s['appCardStatus']}>{status}</span>}
      <span className={s['appCardAct']}>
        {c !== null || card.targets.length > 0 ? (
          <>
            <span className={s['state']} data-state={isConnected(card) ? 'landed' : 'your-turn'}>
              {isConnected(card) ? a.connected : a.needsSignIn}
            </span>
            {c !== null || card.targets.some((t) => t.health !== 'ok') ? (
              <Button size="compact" onClick={onOpen} aria-label={`${a.manage} ${card.name}`}>
                {a.manage}
              </Button>
            ) : null}
          </>
        ) : card.entry?.access === 'connect' || card.entry?.access === 'built-in' ? (
          <Button size="compact" onClick={onConnect} aria-label={`${a.connectOne} ${card.name}`}>
            {a.connectOne}
          </Button>
        ) : (
          <span className={s['needWhy']}>
            {card.entry?.access === 'coming' ? a.comingSoon : a.needsSetup}
          </span>
        )}
      </span>
    </div>
  );
}

/** A connected app: what it can do, where it may be used, sign in again, disconnect. */
function AppDetail({ app, onClose }: { app: ConnectedApp; onClose: () => void }) {
  const a = copy.one.apps;
  const reads = app.tools.filter((t) => t.readOnly).length;
  return (
    <section className={s['box']} aria-label={app.name} data-one-app-detail={app.id}>
      <div className={s['head']}>
        <AppLogo
          id={app.kind === 'meta-ads' ? 'meta-ads' : (catalogueEntryFor(app.url)?.id ?? app.id)}
          name={app.name}
        />
        <h2 className={s['h3']}>{app.name}</h2>
        <span className={s['push']} />
        {app.kind === 'mcp' && app.status !== 'connected' && app.status !== 'signing-in' ? (
          <Button
            variant="accent"
            size="regular"
            onClick={() => void command('connectedApps.signIn', { appId: app.id })}
          >
            {a.signIn}
          </Button>
        ) : null}
        <Button
          size="regular"
          aria-label={`${a.remove} ${app.name}`}
          onClick={() => {
            void command('connectedApps.remove', { appId: app.id });
            onClose();
          }}
        >
          {a.remove}
        </Button>
        <Button size="regular" onClick={onClose}>
          {a.done}
        </Button>
      </div>
      <p className={s['lead']} role="status">
        {app.status === 'connected'
          ? `${fill(a.tools, { n: app.tools.length })} · ${reads} ${a.readOnly} · ${a.asks}`
          : app.status === 'error' && app.error !== null
            ? `${a.status.error}: ${app.error}`
            : app.kind !== 'mcp'
              ? a.meta.replace
              : a.status[app.status]}
      </p>
      <UsedIn app={app} />
    </section>
  );
}
