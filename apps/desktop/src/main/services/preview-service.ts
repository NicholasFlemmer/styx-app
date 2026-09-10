import { WebContentsView, shell, type BrowserWindow } from 'electron';
import { PREVIEW_VIEWPORTS, type PreviewDevice } from '@styx/core';
import { logger } from './logger';

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The design window: the running app rendered live inside Styx, beside the code.
 *
 * A native `WebContentsView` rather than an iframe or a `<webview>`. An iframe cannot work — the renderer's CSP
 * is `default-src 'self'`, so it could never load a dev server — and `<webview>` is deprecated and would run
 * inside the renderer process, which is exactly where untrusted page code should not be. A separate view also
 * means a crashing dev server cannot take the app down with it.
 *
 * The cost of being native is that it paints *above* the DOM: it would sit on top of the palette, a modal, the
 * grant sheet and toasts. So the renderer owns visibility — it reports `visible: false` whenever an overlay is
 * open — and this service simply obeys.
 */
export class PreviewService {
  private view: WebContentsView | null = null;
  private window: BrowserWindow | null = null;
  private loaded: string | null = null;

  constructor(private readonly deps: { mainWindow: () => BrowserWindow | null }) {}

  /**
   * The one entry point: where the hole in the renderer's layout is, what to show in it, and whether to show it
   * at all. Called on layout changes, so it must be cheap and idempotent.
   */
  set(input: { visible: boolean; bounds: PreviewBounds; url: string; device: PreviewDevice }): void {
    if (!input.visible || input.url.trim() === '' || input.bounds.width <= 0 || input.bounds.height <= 0) {
      this.detach();
      return;
    }
    const win = this.deps.mainWindow();
    if (win === null || win.isDestroyed()) return;
    const view = this.ensure(win);
    const url = normaliseUrl(input.url);
    if (url === null) {
      this.detach();
      return;
    }
    if (url !== this.loaded) {
      this.loaded = url;
      void view.webContents.loadURL(url).catch((e: Error) => {
        logger.warn('preview: load failed', { url, error: e.message });
      });
    }
    view.setBounds(deviceBounds(input.bounds, input.device));
  }

  reload(): void {
    this.view?.webContents.reload();
  }

  /** Opens the previewed URL in the OS browser, where devtools and extensions live. */
  async openExternal(url: string): Promise<void> {
    const safe = normaliseUrl(url);
    if (safe === null) return;
    await shell.openExternal(safe);
  }

  /** Detaches on window close / app teardown. Kept separate from `set` so teardown never needs bounds. */
  detach(): void {
    if (this.view === null) return;
    const win = this.window;
    if (win !== null && !win.isDestroyed()) win.contentView.removeChildView(this.view);
    this.view.webContents.close();
    this.view = null;
    this.window = null;
    this.loaded = null;
  }

  private ensure(win: BrowserWindow): WebContentsView {
    if (this.view !== null && this.window === win) return this.view;
    this.detach();
    const view = new WebContentsView({
      webPreferences: {
        // The previewed page is the user's own app, but it is still web content Styx does not control:
        // no node, isolated, sandboxed.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    // A preview must never become a way to navigate Styx itself or spawn windows.
    view.webContents.setWindowOpenHandler(({ url }) => {
      void this.openExternal(url);
      return { action: 'deny' };
    });
    win.contentView.addChildView(view);
    this.view = view;
    this.window = win;
    return view;
  }

}

/**
 * Where the view actually sits. A preset makes the view genuinely that wide rather than emulating a viewport:
 * `enableDeviceEmulation`'s `viewSize` does not change the page's layout viewport once the view is resized, so
 * the page kept reporting the pane's width. Sizing the view for real means media queries, `innerWidth` and
 * anything else the page measures all agree, and the surrounding pane reads as the device's frame.
 * The device box is centred and clamped, so a narrow pane still shows as much as it can.
 */
export const deviceBounds = (pane: PreviewBounds, device: PreviewDevice): PreviewBounds => {
  if (device === 'desktop') return { ...pane };
  const want = PREVIEW_VIEWPORTS[device];
  const width = Math.min(want.width, pane.width);
  const height = Math.min(want.height, pane.height);
  return {
    x: Math.round(pane.x + (pane.width - width) / 2),
    y: Math.round(pane.y + (pane.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
};

/** http/https only, and only a URL that parses: a preview must never be a file:// or app:// navigation. */
export const normaliseUrl = (raw: string): string | null => {
  const text = raw.trim();
  if (text === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
};
