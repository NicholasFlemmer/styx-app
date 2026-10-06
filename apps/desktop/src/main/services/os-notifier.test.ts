import { describe, expect, it, vi } from 'vitest';
import type { TrayMenuItem } from './notification-service';
import {
  ElectronOsNotifier,
  askUrl,
  encodePng,
  toastXml,
  trayIconDataUrl,
  type ElectronLike,
  type NotificationOptions,
  type TrayLike,
} from './os-notifier';

function fakeElectron(platform: NodeJS.Platform) {
  const trays: (TrayLike & { image: unknown; menu: unknown; handlers: (() => void)[]; tip: string })[] = [];
  const notes: {
    opts: NotificationOptions;
    handlers: Record<string, (...a: unknown[]) => void>;
    shown: boolean;
  }[] = [];
  const dock = { setBadge: vi.fn(), bounce: vi.fn(), setMenu: vi.fn() };
  const overlay = vi.fn();
  const e: ElectronLike = {
    platform,
    dock: platform === 'darwin' ? dock : null,
    createTray: (image) => {
      const t = {
        image,
        menu: null as unknown,
        tip: '',
        handlers: [] as (() => void)[],
        setImage(i: unknown) {
          this.image = i;
        },
        setToolTip(s: string) {
          this.tip = s;
        },
        setContextMenu(m: unknown) {
          this.menu = m;
        },
        on(_ev: 'click', fn: () => void) {
          this.handlers.push(fn);
          return this;
        },
        destroy: vi.fn(),
      };
      trays.push(t);
      return t;
    },
    buildMenu: (template: TrayMenuItem[]) => ({ template }),
    imageFromDataUrl: (url) => ({ url }),
    notificationsSupported: () => true,
    createNotification: (opts) => {
      const n = {
        opts,
        handlers: {} as Record<string, (...a: unknown[]) => void>,
        shown: false,
        on(ev: string, fn: (...a: unknown[]) => void) {
          this.handlers[ev] = fn;
          return this;
        },
        show() {
          this.shown = true;
        },
      };
      notes.push(n);
      return n;
    },
    setOverlayIcon: overlay,
  };
  return { e, trays, notes, dock, overlay };
}

describe('tray icon PNG', () => {
  it('encodes a valid 16×16 RGBA PNG and produces two distinct variants', () => {
    const png = encodePng(16, () => [0, 0, 0, 0]);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(Buffer.from(png.subarray(12, 16)).toString('ascii')).toBe('IHDR');
    expect(new DataView(png.buffer, png.byteOffset).getUint32(16)).toBe(16); // width
    expect(new DataView(png.buffer, png.byteOffset).getUint32(20)).toBe(16); // height
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // RGBA
    const idle = trayIconDataUrl(false);
    const attention = trayIconDataUrl(true);
    expect(idle.startsWith('data:image/png;base64,')).toBe(true);
    expect(attention).not.toBe(idle);
    expect(trayIconDataUrl(true, 'light')).not.toBe(attention);
  });
});

describe('toastXml', () => {
  it('carries Review / Later as styx:// protocol buttons and escapes text', () => {
    const xml = toastXml({
      id: 'ask 1',
      title: 'Codex wants Supabase prod · write',
      body: 'acme & co "x"',
      sound: false,
    });
    expect(xml).toContain(`arguments="${askUrl('ask 1', 'review')}" activationType="protocol"`);
    expect(xml).toContain(`arguments="${askUrl('ask 1', 'later')}" activationType="protocol"`);
    expect(xml).toContain('acme &amp; co &quot;x&quot;');
    expect(xml).toContain('<audio silent="true"/>');
    expect(toastXml({ id: 'a', title: 't', body: 'b', sound: true })).not.toContain('<audio');
    expect(askUrl('01H', 'review')).toBe('styx://ask/01H/review');
  });
});

describe('ElectronOsNotifier', () => {
  const menu: TrayMenuItem[] = [
    { label: '2 need you' },
    { label: '', type: 'separator' },
    { label: 'Do Not Disturb', type: 'checkbox', checked: false },
  ];

  it('Windows: one tray, accent-dot image swaps with attention, left-click opens the board, toasts use toastXml', () => {
    const { e, trays, notes, overlay } = fakeElectron('win32');
    const os = new ElectronOsNotifier(e);
    const onClick = vi.fn();
    os.setTray({ attention: false, menu, onClick });
    os.setTray({ attention: true, menu, onClick });
    os.setTray({ attention: true, menu, onClick });
    expect(trays.length).toBe(1);
    expect(trays[0]?.image).toEqual({ url: trayIconDataUrl(true) });
    expect(trays[0]?.tip).toBe('Styx — 2 need you');
    expect(trays[0]?.menu).toEqual({ template: menu });
    trays[0]?.handlers.forEach((h) => h());
    expect(onClick).toHaveBeenCalledTimes(1);

    os.setBadge(2);
    expect(overlay).toHaveBeenLastCalledWith({ url: trayIconDataUrl(true) }, '2 need you');
    os.setBadge(0);
    expect(overlay).toHaveBeenLastCalledWith(null, '');
    os.bounceOnce(); // no-op off macOS

    const onReview = vi.fn();
    const onLater = vi.fn();
    os.toast({ id: 'a1', title: 'T', body: 'B', sound: false, onReview, onLater });
    expect(notes[0]?.opts.toastXml).toContain('styx://ask/a1/review');
    expect(notes[0]?.shown).toBe(true);
    notes[0]?.handlers['click']?.();
    notes[0]?.handlers['close']?.();
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onLater).toHaveBeenCalledTimes(1);
    os.dispose();
    expect(trays[0]?.destroy).toHaveBeenCalled();
  });

  it('Linux: a tray like Windows, and plain desktop notifications with a Review button', () => {
    const { e, trays, notes, dock } = fakeElectron('linux');
    const os = new ElectronOsNotifier(e);
    const onClick = vi.fn();
    os.setTray({ attention: true, menu, onClick });
    expect(trays.length).toBe(1);
    expect(trays[0]?.image).toEqual({ url: trayIconDataUrl(true) });
    trays[0]?.handlers.forEach((h) => h());
    expect(onClick).toHaveBeenCalledTimes(1);
    os.bounceOnce(); // no dock to bounce
    expect(dock.bounce).not.toHaveBeenCalled();

    const onReview = vi.fn();
    os.toast({ id: 'a1', title: 'T', body: 'B', sound: true, onReview, onLater: vi.fn() });
    expect(notes[0]?.opts).toMatchObject({ title: 'T', body: 'B', silent: false });
    expect(notes[0]?.opts.toastXml).toBeUndefined();
    notes[0]?.handlers['action']?.();
    expect(onReview).toHaveBeenCalledTimes(1);
    os.dispose();
  });

  it('macOS: dock badge, bounce, dock menu, Notification Center toast with Review action and Later close button', () => {
    const { e, trays, notes, dock } = fakeElectron('darwin');
    const os = new ElectronOsNotifier(e);
    os.setBadge(3);
    expect(dock.setBadge).toHaveBeenLastCalledWith('3');
    os.setBadge(0);
    expect(dock.setBadge).toHaveBeenLastCalledWith('');
    os.bounceOnce();
    expect(dock.bounce).toHaveBeenCalledWith('informational');
    os.setTray({ attention: true, menu, onClick: () => undefined });
    expect(dock.setMenu).toHaveBeenCalledWith({ template: menu });
    expect(trays.length).toBe(0);
    const onReview = vi.fn();
    os.toast({ id: 'a1', title: 'T', body: 'B', sound: true, onReview, onLater: () => undefined });
    expect(notes[0]?.opts).toEqual({
      title: 'T',
      body: 'B',
      silent: false,
      actions: [{ type: 'button', text: 'Review' }],
      closeButtonText: 'Later',
    });
    notes[0]?.handlers['action']?.();
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it('skips toasts when the OS does not support notifications', () => {
    const { e, notes } = fakeElectron('darwin');
    const os = new ElectronOsNotifier({ ...e, notificationsSupported: () => false });
    os.toast({
      id: 'a',
      title: 't',
      body: 'b',
      sound: false,
      onReview: () => undefined,
      onLater: () => undefined,
    });
    expect(notes.length).toBe(0);
  });
});
