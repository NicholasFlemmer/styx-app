import { deflateSync } from 'node:zlib';
import { colors } from '@styx/tokens';
import type { OsNotifier, TrayMenuItem } from './notification-service';

/**
 * The Electron surface `ElectronOsNotifier` touches, narrowed so unit tests inject fakes and nothing here imports
 * `electron` at module load (container/tests stay Electron-free; `index.ts` passes the real modules).
 */
export interface TrayLike {
  setImage(image: unknown): void;
  setToolTip(text: string): void;
  setContextMenu(menu: unknown): void;
  on(event: 'click', fn: () => void): unknown;
  destroy(): void;
}

export interface NotificationLike {
  on(event: 'click' | 'action' | 'close' | 'failed', fn: (...args: unknown[]) => void): unknown;
  show(): void;
}

export interface NotificationOptions {
  title?: string;
  body?: string;
  silent?: boolean;
  /** macOS: extra buttons; `closeButtonText` is the second (Later) action. */
  actions?: { type: 'button'; text: string }[];
  closeButtonText?: string;
  /** Windows: full toast XML (Action Center buttons use `activationType="protocol"`). */
  toastXml?: string;
}

export interface ElectronLike {
  platform: NodeJS.Platform;
  dock: {
    setBadge(text: string): void;
    bounce(type: 'informational'): void;
    setMenu(menu: unknown): void;
  } | null;
  createTray(image: unknown): TrayLike;
  buildMenu(template: TrayMenuItem[]): unknown;
  imageFromDataUrl(dataUrl: string): unknown;
  notificationsSupported(): boolean;
  createNotification(opts: NotificationOptions): NotificationLike;
  /** Windows taskbar overlay badge on the main window (when it exists). */
  setOverlayIcon(image: unknown, description: string): void;
}

/** Deep-links the OS toast buttons resolve to (index.ts `handleUrl`). */
export const askUrl = (askId: string, action: 'review' | 'later'): string =>
  `styx://ask/${encodeURIComponent(askId)}/${action}`;

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Windows Action Center toast: title, mono meta, Review / Later protocol buttons (spec §4.14). */
export function toastXml(n: { id: string; title: string; body: string; sound: boolean }): string {
  return (
    `<toast launch="${escapeXml(askUrl(n.id, 'review'))}" activationType="protocol">` +
    `<visual><binding template="ToastGeneric">` +
    `<text>Needs you · Styx</text><text>${escapeXml(n.title)}</text><text>${escapeXml(n.body)}</text>` +
    `</binding></visual>` +
    `<actions>` +
    `<action content="Review" arguments="${escapeXml(askUrl(n.id, 'review'))}" activationType="protocol"/>` +
    `<action content="Later" arguments="${escapeXml(askUrl(n.id, 'later'))}" activationType="protocol"/>` +
    `</actions>` +
    (n.sound ? '' : '<audio silent="true"/>') +
    `</toast>`
  );
}

// --- tiny PNG encoder (tray icons are generated at runtime; no image assets) ----------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(Buffer.from(type, 'ascii'), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

export type Rgba = [number, number, number, number];

/** RGBA PNG from a pixel function; `size × size`, 8-bit, no filtering. */
export function encodePng(size: number, pixel: (x: number, y: number) => Rgba): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const n = parseInt(
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h,
    16,
  );
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

/**
 * 16 px tray icon, two variants (spec §4.14 "tray icon with accent dot"): a square outline glyph, plus a filled
 * accent square dot in the corner when `attention`. Square dots, no anti-aliasing — matches the app's vocabulary.
 */
export function trayIconDataUrl(attention: boolean, theme: 'dark' | 'light' = 'dark'): string {
  const fg = hexRgb(colors[theme].tx);
  const ac = hexRgb(colors[theme].ac);
  const png = encodePng(16, (x, y) => {
    // Outline square 2..11 (2px stroke), leaving room for the dot at 10..15.
    const onOutline = x >= 2 && x <= 11 && y >= 2 && y <= 11 && (x <= 3 || x >= 10 || y <= 3 || y >= 10);
    const inDot = attention && x >= 9 && x <= 14 && y >= 9 && y <= 14;
    if (inDot) return [ac[0], ac[1], ac[2], 255];
    if (onOutline) return [fg[0], fg[1], fg[2], 255];
    return [0, 0, 0, 0];
  });
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

/**
 * The real `OsNotifier`: Windows tray + Action Center toasts, macOS dock badge / bounce / menu + Notification Center.
 * Everything Electron-specific arrives through `ElectronLike` so this can be unit-tested with fakes.
 */
export class ElectronOsNotifier implements OsNotifier {
  private tray: TrayLike | null = null;
  private trayAttention: boolean | null = null;
  private onTrayClick: () => void = () => undefined;

  constructor(
    private readonly e: ElectronLike,
    private readonly theme: () => 'dark' | 'light' = () => 'dark',
  ) {}

  setBadge(count: number): void {
    if (this.e.platform === 'darwin') this.e.dock?.setBadge(count > 0 ? String(count) : '');
    else
      this.e.setOverlayIcon(
        count > 0 ? this.e.imageFromDataUrl(trayIconDataUrl(true, this.theme())) : null,
        count > 0 ? `${count} need you` : '',
      );
  }

  bounceOnce(): void {
    if (this.e.platform === 'darwin') this.e.dock?.bounce('informational');
  }

  toast(n: {
    id: string;
    title: string;
    body: string;
    sound: boolean;
    onReview: () => void;
    onLater: () => void;
  }): void {
    if (!this.e.notificationsSupported()) return;
    const note =
      this.e.platform === 'win32'
        ? this.e.createNotification({ toastXml: toastXml(n) })
        : this.e.createNotification({
            title: n.title,
            body: n.body,
            silent: !n.sound,
            actions: [{ type: 'button', text: 'Review' }],
            closeButtonText: 'Later',
          });
    // Windows buttons are protocol activations (styx://ask/…), routed by index.ts; click/action here cover macOS
    // and the toast body on both platforms.
    note.on('click', () => n.onReview());
    note.on('action', () => n.onReview());
    note.on('close', () => n.onLater());
    note.show();
  }

  setTray(opts: { attention: boolean; menu: TrayMenuItem[]; onClick: () => void }): void {
    this.onTrayClick = opts.onClick;
    const menu = this.e.buildMenu(opts.menu);
    if (this.e.platform === 'darwin') {
      this.e.dock?.setMenu(menu);
      return;
    }
    if (this.e.platform !== 'win32') return;
    if (!this.tray) {
      this.tray = this.e.createTray(this.e.imageFromDataUrl(trayIconDataUrl(opts.attention, this.theme())));
      this.tray.on('click', () => this.onTrayClick());
      this.trayAttention = opts.attention;
    } else if (this.trayAttention !== opts.attention) {
      this.tray.setImage(this.e.imageFromDataUrl(trayIconDataUrl(opts.attention, this.theme())));
      this.trayAttention = opts.attention;
    }
    this.tray.setToolTip(opts.menu[0]?.label ? `Styx — ${opts.menu[0].label}` : 'Styx');
    this.tray.setContextMenu(menu);
  }

  dispose(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
