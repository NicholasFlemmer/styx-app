import { agentSchema, copy, idFrom, type EventPayload } from '@styx/core';
import type { KvStore } from '../db/kv';
import type { Repos } from '../db/repos';

export interface TrayMenuItem {
  label: string;
  click?: () => void;
  type?: 'separator' | 'checkbox';
  checked?: boolean;
}

export interface OsNotifier {
  /** macOS: dock badge count + single bounce on first ask; Windows: tray accent dot. */
  setBadge(count: number): void;
  bounceOnce(): void;
  /** OS toast (Windows Action Center; macOS Notification Center) with Review / Later actions. */
  toast(n: {
    id: string;
    title: string;
    body: string;
    sound: boolean;
    onReview: () => void;
    onLater: () => void;
  }): void;
  /** Windows tray (accent dot when `attention`, left-click → `onClick`) / macOS dock menu with the same items. */
  setTray(opts: { attention: boolean; menu: TrayMenuItem[]; onClick: () => void }): void;
}

export interface AskSummary {
  askId: string;
  sessionId: string;
  projectName: string;
  branch: string | null;
  agentLabel: string;
  title: string; // "Codex wants Supabase prod · write"
  meta: string; // 'acme-shop · test/flaky · "migration 0042"'
}

/** Attention plumbing (spec §4.14): in-app toasts are renderer-side from `ask.opened`; this owns badge, bounce, tray, DND and OS toasts. */
export class NotificationService {
  private bounced = false;
  private recent: AskSummary[] = [];
  private openCount = 0;

  constructor(
    private readonly os: OsNotifier,
    private readonly kv: KvStore,
    private readonly platform: NodeJS.Platform,
    private readonly actions: {
      review: (ask: AskSummary) => void;
      later: (ask: AskSummary) => void;
      openBoard: () => void;
    },
    /** "Badge + sound" app setting; badge-only by default. */
    private readonly soundEnabled: () => boolean = () => false,
  ) {}

  get dnd(): boolean {
    return this.kv.get<boolean>('notify.dnd') ?? false;
  }

  setDnd(on: boolean): void {
    this.kv.set('notify.dnd', on);
    this.refreshTray();
  }

  get sound(): boolean {
    return this.soundEnabled();
  }

  /** Puts the tray / dock menu up at launch with the persisted open-ask count and DND state. */
  start(openCount: number): void {
    this.openCount = openCount;
    this.os.setBadge(openCount);
    this.refreshTray();
  }

  onAskOpened(ask: AskSummary, openCount: number): void {
    this.openCount = openCount;
    this.recent = [ask, ...this.recent.filter((a) => a.askId !== ask.askId)].slice(0, 5);
    this.os.setBadge(openCount);
    if (!this.bounced && this.platform === 'darwin') {
      this.os.bounceOnce();
      this.bounced = true; // never repeatedly
    }
    this.refreshTray();
    if (!this.dnd)
      this.os.toast({
        id: ask.askId,
        title: ask.title,
        body: ask.meta,
        sound: this.sound,
        onReview: () => this.actions.review(ask),
        onLater: () => this.actions.later(ask),
      });
  }

  onAskResolved(askId: string, openCount: number): void {
    this.openCount = openCount;
    this.recent = this.recent.filter((a) => a.askId !== askId);
    this.os.setBadge(openCount);
    if (openCount === 0) this.bounced = false;
    this.refreshTray();
  }

  private refreshTray(): void {
    this.os.setTray({
      attention: this.openCount > 0,
      onClick: this.actions.openBoard,
      menu: [
        {
          label: this.openCount ? `${this.openCount} need you` : 'Nothing waiting on you',
          click: this.actions.openBoard,
        },
        ...this.recent.map((a) => ({
          label: `${a.agentLabel} · ${a.projectName} · ${a.title}`,
          click: () => this.actions.review(a),
        })),
        { label: '', type: 'separator' as const },
        {
          label: 'Do Not Disturb',
          type: 'checkbox' as const,
          checked: this.dnd,
          click: () => this.setDnd(!this.dnd),
        },
      ],
    });
  }
}

/**
 * Persistent banners still `shown` in `notifications` (keyed by `banner_key`), rebuilt as `banner.set` payloads so a
 * freshly connected window sees them again after a restart. Keys: `auth-expired:<targetId>` · `cli-missing:<agent>` ·
 * `conflict:<worktreeId>`; unknown keys are skipped.
 */
export function bannersToReemit(repos: Repos): EventPayload<'banner.set'>[] {
  const out: EventPayload<'banner.set'>[] = [];
  for (const n of repos.notifications.all()) {
    if (n.kind !== 'error-banner' || n.state !== 'shown' || !n.bannerKey) continue;
    const sep = n.bannerKey.indexOf(':');
    const kind = n.bannerKey.slice(0, sep);
    const id = n.bannerKey.slice(sep + 1);
    if (!id) continue;
    if (kind === 'auth-expired') {
      if (!repos.targets.get(id)) continue;
      out.push({
        bannerKey: n.bannerKey,
        kind: 'auth-expired',
        text: n.title,
        cta: copy.errors.authExpired.cta,
        action: { kind: 'reconnect', targetId: idFrom<'TargetId'>(id) },
        sessionId: n.sessionId,
        reason: 'auth-expired',
      });
    } else if (kind === 'cli-missing') {
      const agent = agentSchema.safeParse(id);
      if (!agent.success) continue;
      out.push({
        bannerKey: n.bannerKey,
        kind: 'cli-missing',
        text: n.title,
        cta: copy.errors.cliMissing.cta,
        action: { kind: 'install-guide', agent: agent.data },
        sessionId: n.sessionId,
        reason: 'cli-missing',
      });
    } else if (kind === 'conflict') {
      const wt = repos.worktrees.get(id);
      if (!wt) continue;
      out.push({
        bannerKey: n.bannerKey,
        kind: 'conflict',
        text: n.title,
        cta: copy.errors.conflict.cta,
        action: { kind: 'resolve', worktreeId: wt.id },
        sessionId: n.sessionId,
        reason: 'conflict',
      });
    }
  }
  return out;
}
