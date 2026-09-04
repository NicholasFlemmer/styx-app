import type { KvStore } from '../db/kv';

export interface OsNotifier {
  /** macOS: dock badge count + single bounce on first ask; Windows: tray accent dot. */
  setBadge(count: number): void;
  bounceOnce(): void;
  /** OS toast (Windows Action Center; macOS Notification Center) with Review / Later actions. */
  toast(n: { id: string; title: string; body: string; onReview: () => void; onLater: () => void }): void;
  setTray(opts: { attention: boolean; menu: { label: string; click?: () => void; type?: 'separator' | 'checkbox'; checked?: boolean }[] }): void;
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
    private readonly actions: { review: (ask: AskSummary) => void; later: (ask: AskSummary) => void; openBoard: () => void },
  ) {}

  get dnd(): boolean {
    return this.kv.get<boolean>('notify.dnd') ?? false;
  }

  setDnd(on: boolean): void {
    this.kv.set('notify.dnd', on);
    this.refreshTray();
  }

  /** Sound is opt-in ("Badge + sound" setting); default is badge only. */
  get sound(): boolean {
    return this.kv.get<string>('notify.mode') === 'badge+sound';
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
    if (!this.dnd) this.os.toast({ id: ask.askId, title: ask.title, body: ask.meta, onReview: () => this.actions.review(ask), onLater: () => this.actions.later(ask) });
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
      menu: [
        { label: this.openCount ? `${this.openCount} need you` : 'Nothing waiting on you', click: this.actions.openBoard },
        ...this.recent.map((a) => ({ label: `${a.agentLabel} · ${a.projectName} · ${a.title}`, click: () => this.actions.review(a) })),
        { label: '', type: 'separator' as const },
        { label: 'Do Not Disturb', type: 'checkbox' as const, checked: this.dnd, click: () => this.setDnd(!this.dnd) },
      ],
    });
  }
}
