import { copy, fill, formatAge, rows, type EventPayload, type ReadModel } from '@styx/core';

export type BannerAction = EventPayload<'banner.set'>['action'];

export interface BannerRow {
  key: string;
  kind: EventPayload<'banner.set'>['kind'];
  text: string;
  cta: string;
  action: BannerAction;
}

/**
 * Error banners derived from the read model (spec §3): expired target credentials, sessions paused because a CLI
 * is missing (one row per CLI), and worktree conflicts. Copy from core `copy.errors`.
 */
export const deriveBanners = (model: ReadModel, now: number): BannerRow[] => {
  const out: BannerRow[] = [];
  for (const t of rows(model.targets)) {
    if (t.health !== 'expired') continue;
    out.push({
      key: `auth-expired:${t.id}`,
      kind: 'auth-expired',
      text: fill(copy.errors.authExpired.text, {
        target: t.name,
        t: formatAge(t.expiredAt ?? t.healthCheckedAt, now),
      }),
      cta: copy.errors.authExpired.cta,
      action: { kind: 'reconnect', targetId: t.id },
    });
  }
  const missing = new Map<string, number>();
  for (const s of rows(model.sessions)) {
    if (s.archivedAt !== null || s.state !== 'paused' || s.pausedReason !== 'cli-missing') continue;
    missing.set(s.agent, (missing.get(s.agent) ?? 0) + 1);
  }
  for (const s of rows(model.sessions)) {
    if (s.archivedAt !== null || s.state !== 'paused' || s.pausedReason !== 'cli-missing') continue;
    const key = `cli-missing:${s.agent}`;
    if (out.some((b) => b.key === key)) continue;
    const n = missing.get(s.agent) ?? 1;
    out.push({
      key,
      kind: 'cli-missing',
      text:
        n === 1
          ? fill(copy.errors.cliMissing.textOne, { cli: s.agent })
          : fill(copy.errors.cliMissing.text, { cli: s.agent, n }),
      cta: copy.errors.cliMissing.cta,
      action: { kind: 'install-guide', agent: s.agent },
    });
  }
  for (const w of rows(model.worktrees)) {
    if (w.conflict === null || w.archivedAt !== null) continue;
    const owner = w.owner.kind === 'session' ? model.sessions.byId[w.owner.sessionId] : undefined;
    const agent = owner === undefined ? copy.general.none : copy.agents[owner.agent];
    out.push({
      key: `conflict:${w.id}`,
      kind: 'conflict',
      text: fill(copy.errors.conflict.text, {
        branch: w.branch ?? copy.general.none,
        file: w.conflict.file,
        agent,
      }),
      cta: copy.errors.conflict.cta,
      action: { kind: 'resolve', worktreeId: w.id },
    });
  }
  // Updates in place (#119): a downloaded build waits for the next quit; the banner offers it now.
  if (model.update.status === 'ready' && model.update.next !== null) {
    const working = rows(model.sessions).filter(
      (s) => s.archivedAt === null && (s.state === 'working' || s.state === 'needs-you'),
    ).length;
    out.push({
      key: `update-ready:${model.update.next}`,
      kind: 'update-ready',
      text:
        working === 0
          ? fill(copy.update.banner, { version: model.update.next })
          : fill(copy.update.bannerBusy, { version: model.update.next, n: working }),
      cta: copy.update.restart,
      action: { kind: 'install-update' },
    });
  }
  return out;
};

/** Event rows (main) override derived rows with the same key; dismissed keys are hidden until re-set. */
export const mergeBanners = (
  derived: readonly BannerRow[],
  events: Readonly<Record<string, EventPayload<'banner.set'>>>,
  dismissed: readonly string[],
): BannerRow[] => {
  const byKey = new Map<string, BannerRow>();
  for (const b of derived) byKey.set(b.key, b);
  for (const e of Object.values(events)) {
    byKey.set(e.bannerKey, { key: e.bannerKey, kind: e.kind, text: e.text, cta: e.cta, action: e.action });
  }
  return [...byKey.values()].filter((b) => !dismissed.includes(b.key));
};
